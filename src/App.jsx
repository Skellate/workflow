import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query as firestoreQuery, runTransaction, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { getBlob, ref, uploadBytes } from 'firebase/storage';
import { useSession } from './AuthGate.jsx';
import { db, storage } from './firebase.js';
import { reviewAccessRequest } from './reviewAccessRequest.js';

const defaultSuppliers = [
  { id: 'smc', name: 'SMC Corporation', category: 'Pneumatics & air fittings', contact: 'Daniel Morris', email: 'daniel.morris@smc.example', phone: '+27 11 444 2080', initials: 'SM', color: 'blue' },
  { id: 'tapeflow', name: 'Tapeflow', category: 'Dosing & metering pumps', contact: 'Leanne Jacobs', email: 'leanne@tapeflow.example', phone: '+27 21 555 0142', initials: 'TF', color: 'orange' },
  { id: 'grundfos', name: 'Grundfos', category: 'Centrifugal pumps', contact: 'Peter Naidoo', email: 'peter.naidoo@grundfos.example', phone: '+27 11 789 3000', initials: 'G', color: 'purple' },
  { id: 'endress-hauser', name: 'Endress+Hauser', category: 'Instrumentation', contact: 'Mia Botha', email: 'mia.botha@eh.example', phone: '+27 11 262 8000', initials: 'EH', color: 'green' },
];

const stages = ['Quotation', 'Order received', 'Engineering', 'Procurement', 'Manufacturing', 'Delivery'];
const equipmentProgressOptions = ['Not Ordered/Booked Out', 'Awaiting Quote', 'Received Quote', 'On-order', 'Onsite', 'Received'];

function equipmentProgressClass(progress) {
  const classes = {
    'Not Ordered/Booked Out': 'progress-not-ordered',
    'Awaiting Quote': 'progress-awaiting-quote',
    'Received Quote': 'progress-received-quote',
    'On-order': 'progress-on-order',
    Onsite: 'progress-onsite',
    Received: 'progress-received',
  };
  return classes[progress] || 'progress-unknown';
}

function normalizeEquipmentCode(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function equipmentCounterId(area, group) {
  const normalizedArea = normalizeEquipmentCode(area) || '_';
  const normalizedGroup = normalizeEquipmentCode(group) || '_';
  return `${encodeURIComponent(normalizedArea)}__${encodeURIComponent(normalizedGroup)}`;
}

function getNumericEquipmentId(value) {
  const text = String(value || '');
  return /^\d+$/.test(text) ? Number(text) : null;
}

function getEquipmentNumbers(items, area, group, excludeId) {
  const samePair = (item) => normalizeEquipmentCode(item.area) === normalizeEquipmentCode(area)
    && normalizeEquipmentCode(item.group) === normalizeEquipmentCode(group);
  return items
    .filter((item) => item.id !== excludeId && samePair(item))
    .map((item) => getNumericEquipmentId(item.equipmentId))
    .filter((number) => number !== null);
}

function getUsedEquipmentNumbers(counterData, items, area, group, excludeId) {
  const used = new Set((Array.isArray(counterData?.usedIds) ? counterData.usedIds : [])
    .map(Number)
    .filter((number) => Number.isSafeInteger(number) && number > 0));
  if (!counterData?.initialized) {
    getEquipmentNumbers(items, area, group, excludeId).forEach((number) => used.add(number));
  }
  return used;
}

function getEquipmentIdWidth(counterData, items, area, group, excludeId, used) {
  const existingWidths = items
    .filter((item) => item.id !== excludeId
      && normalizeEquipmentCode(item.area) === normalizeEquipmentCode(area)
      && normalizeEquipmentCode(item.group) === normalizeEquipmentCode(group))
    .map((item) => /^\d+$/.test(String(item.equipmentId || '')) ? String(item.equipmentId).length : 0);
  return Math.max(2, Number(counterData?.width) || 0, ...existingWidths, ...[...used].map((number) => String(number).length));
}

function getFirstAvailableEquipmentNumber(used) {
  let number = 1;
  while (used.has(number)) number += 1;
  return number;
}

function getNextEquipmentId(area, group, items, counters, excludeId) {
  const counter = counters.find((item) => item.id === equipmentCounterId(area, group));
  const used = getUsedEquipmentNumbers(counter, items, area, group, excludeId);
  const nextNumber = getFirstAvailableEquipmentNumber(used);
  return String(nextNumber).padStart(getEquipmentIdWidth(counter, items, area, group, excludeId, used), '0');
}

function writeEquipmentCounter(transaction, counterRef, area, group, used, width) {
  transaction.set(counterRef, {
    area: String(area || '').trim(),
    group: String(group || '').trim(),
    usedIds: [...used].sort((first, second) => first - second),
    initialized: true,
    width,
    updatedAt: serverTimestamp(),
  });
}

async function reserveEquipmentId(transaction, jobId, area, group, items, excludeId) {
  const counterRef = doc(db, 'jobs', jobId, 'equipmentCounters', equipmentCounterId(area, group));
  const counterSnapshot = await transaction.get(counterRef);
  const counterData = counterSnapshot.data();
  const used = getUsedEquipmentNumbers(counterData, items, area, group, excludeId);
  const width = getEquipmentIdWidth(counterData, items, area, group, excludeId, used);
  const nextNumber = getFirstAvailableEquipmentNumber(used);
  used.add(nextNumber);
  const equipmentId = String(nextNumber).padStart(width, '0');
  writeEquipmentCounter(transaction, counterRef, area, group, used, Math.max(width, equipmentId.length));
  return equipmentId;
}

function App() {
  const { user, registeredName, registeredNameError, signOut, isAdmin } = useSession();
  const [page, setPage] = useState('Overview');
  const [jobs, setJobs] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [dataError, setDataError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All jobs');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedJob, setSelectedJob] = useState(null);
  const [toast, setToast] = useState('');
  const [toastType, setToastType] = useState('success');
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('workflow-theme') === 'dark');

  useEffect(() => {
    localStorage.setItem('workflow-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => onSnapshot(
    firestoreQuery(collection(db, 'jobs'), orderBy('createdAt', 'desc')),
    (snapshot) => {
      setJobs(snapshot.docs.map((jobDoc) => ({ id: jobDoc.id, ...jobDoc.data() })));
      setDataError('');
    },
    (error) => setDataError(`Could not load jobs: ${error.message}`),
  ), []);

  const filteredJobs = useMemo(() => jobs.filter((job) => {
    const matchesQuery = `${job.number} ${job.name} ${job.client}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === 'All jobs' || job.status === filter;
    return matchesQuery && matchesFilter;
  }), [jobs, query, filter]);

  const notify = useCallback((message, type = 'success') => {
    setToast(message);
    setToastType(type);
    window.setTimeout(() => setToast(''), type === 'error' ? 6000 : 2600);
  }, []);

  useEffect(() => {
    if (registeredNameError) notify(registeredNameError, 'error');
  }, [registeredNameError, notify]);

  async function createJob(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') || '').trim();
    const client = String(data.get('client') || '').trim();
    if (!name || !client) return;
    const owner = user.displayName || user.email || 'Workspace member';
    const ownerInitials = owner.split(/[\s@.]+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
    const date = data.get('due');
    const notes = String(data.get('notes') || '').trim();
    const due = date ? new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not set';
    try {
      const counterRef = doc(db, 'meta', 'jobCounter');
      const next = await runTransaction(db, async (transaction) => {
        const counter = await transaction.get(counterRef);
        const number = counter.exists() ? counter.data().next : 249;
        if (!Number.isSafeInteger(number) || number < 249) {
          throw new Error('The job number counter is invalid. Ask an administrator to check the Firebase data.');
        }
        transaction.set(counterRef, { next: number + 1 });
        return number;
      });
      const number = `JOB-${String(next).padStart(4, '0')}`;
      await addDoc(collection(db, 'jobs'), {
        number, name, client, owner, ownerInitials, due, stage: 'Quotation',
        progress: 0, status: 'On track', color: 'teal', notes,
        initials: client.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
        createdBy: user.uid, createdAt: serverTimestamp(),
      });
      setShowCreate(false);
      setPage('Jobs');
      notify(`${number} created`);
    } catch (error) {
      notify(`Could not create job: ${error.message}`, 'error');
    }
  }

  function openJob(job) {
    setSelectedJob(job);
    setPage('Job details');
  }
  const currentUserName = user.displayName || user.email || 'Workspace member';
  const currentUserInitials = currentUserName.split(/[\s@.]+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className={`app-shell${darkMode ? ' dark-mode' : ''}`}>
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage('Overview'); setSelectedJob(null); }}>
          <span className="brand-mark"><span /></span>
          <span className="brand-name">workflow<span className="brand-dot">.</span><small>PROJECT WORKSPACE</small></span>
        </a>
        <div className="workspace-switch"><span className="workspace-avatar">{currentUserInitials[0]}</span><span className="workspace-label">Your workspace<span>Engineering team</span></span><span className="chevron">⌄</span></div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="nav-list">
          <NavItem icon="⌂" label="Overview" active={page === 'Overview'} onClick={() => { setPage('Overview'); setSelectedJob(null); }} />
          <NavItem icon="▤" label="Jobs" count={jobs.length} active={page === 'Jobs' || page === 'Job details'} onClick={() => { setPage('Jobs'); setSelectedJob(null); }} />
          <NavItem icon="◷" label="Reminders" count={reminders.length} active={page === 'Reminders'} onClick={() => setPage('Reminders')} />
          <NavItem icon="▦" label="Suppliers" active={page === 'Suppliers'} onClick={() => setPage('Suppliers')} />
          <NavItem icon="⚙" label="Equipment" active={page === 'Equipment'} onClick={() => setPage('Equipment')} />
        </nav>
        <div className="nav-label tools-label">TOOLS</div>
        <nav className="nav-list">
          <NavItem icon="▧" label="Documents" active={page === 'Documents'} onClick={() => setPage('Documents')} />
          <NavItem icon="⚙" label="Settings" active={page === 'Settings'} onClick={() => setPage('Settings')} />
          {isAdmin && <NavItem icon="♙" label="User approvals" active={page === 'User approvals'} onClick={() => setPage('User approvals')} />}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card"><span className="help-icon">?</span><div><strong>Need a hand?</strong><span>Visit the help centre</span></div><span className="help-arrow">↗</span></div>
          <div className="profile"><div className="profile-avatar">{currentUserInitials}<span className="online-dot" /></div><div className="profile-name">{currentUserName}<span>Team member</span></div><button className="more sign-out" title="Sign out" onClick={async () => { try { await signOut(); } catch (error) { notify(`Could not sign out: ${error.message}`, 'error'); } }}>↪</button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>{page === 'Job details' ? selectedJob?.number : page}</strong></div>
          <div className="top-actions">
            <label className="global-search"><span>⌕</span><input aria-label="Search jobs" placeholder="Search anything..." value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd></label>
            <button className="icon-button theme-toggle" aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setDarkMode((enabled) => !enabled)}>{darkMode ? '☼' : '☾'}</button>
            <button className="icon-button notification-button" aria-label="Notifications" onClick={() => setPage('Reminders')}>♧<i /></button>
            <button className="top-avatar sign-out-avatar" title={`Sign out ${currentUserName}`} onClick={async () => { try { await signOut(); } catch (error) { notify(`Could not sign out: ${error.message}`, 'error'); } }}>{currentUserInitials}</button>
          </div>
        </header>

        <div className="page-content">
          {dataError && <div className="data-error" role="alert">{dataError}</div>}
          {page === 'Overview' && <Overview userName={registeredName || user.displayName?.trim() || user.email?.split('@')[0] || 'there'} jobs={jobs} reminders={reminders} onCreate={() => setShowCreate(true)} onOpenJob={openJob} onViewAll={() => setPage('Jobs')} onSeeAll={() => setPage('Reminders')} onDismiss={(id) => setReminders(reminders.filter((item) => item.id !== id))} />}
          {page === 'Jobs' && <JobsPage jobs={filteredJobs} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} onCreate={() => setShowCreate(true)} onOpenJob={openJob} />}
          {page === 'Suppliers' && <SuppliersPage onToast={notify} />}
          {page === 'Equipment' && <EquipmentCatalogPage jobs={jobs} onOpenJob={openJob} />}
          {page === 'Reminders' && <RemindersPage reminders={reminders} onDismiss={(id) => setReminders(reminders.filter((item) => item.id !== id))} onOpenJob={(jobNumber) => { const match = jobs.find((job) => job.number === jobNumber); if (match) openJob(match); else setPage('Jobs'); }} />}
          {page === 'Job details' && selectedJob && <JobDetails job={jobs.find((job) => job.id === selectedJob.id) || selectedJob} user={user} onBack={() => setPage('Jobs')} onToast={notify} />}
          {page === 'Documents' && <EmptyPage icon="▧" title="Project documents" text="Documents uploaded to your jobs will be collected here. Open a job to add quotations, drawings and other project files." onAction={() => { setPage('Jobs'); }} action="Browse jobs" />}
          {page === 'Settings' && <EmptyPage icon="⚙" title="Workspace settings" text="Manage your team and workflow preferences as your workspace grows." onAction={() => notify('Settings are coming soon')} action="Workspace settings" />}
          {page === 'User approvals' && isAdmin && <UserApprovalsPage onToast={notify} />}
        </div>
      </main>

      {showCreate && <CreateJobModal userName={currentUserName} onClose={() => setShowCreate(false)} onSubmit={createJob} />}
      {toast && <div className={`toast ${toastType}`} role="status"><span>{toastType === 'error' ? '!' : '✓'}</span>{toast}</div>}
    </div>
  );
}

function NavItem({ icon, label, active, count, onClick }) {
  return <button className={`nav-item${active ? ' active' : ''}`} onClick={onClick}><span className="nav-icon">{icon}</span><span>{label}</span>{count !== undefined && <span className="nav-count">{count}</span>}</button>;
}

function PageHeading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function UserApprovalsPage({ onToast }) {
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busyUid, setBusyUid] = useState('');

  useEffect(() => onSnapshot(
    collection(db, 'accessRequests'),
    (snapshot) => {
      setRequests(snapshot.docs.map((requestDoc) => ({ id: requestDoc.id, ...requestDoc.data() }))
        .sort((first, second) => (second.createdAt?.toMillis() || 0) - (first.createdAt?.toMillis() || 0)));
      setError('');
      setLoaded(true);
    },
    (snapshotError) => {
      setError(`Could not load access requests: ${snapshotError.message}`);
      setLoaded(true);
    },
  ), []);

  async function review(request, decision) {
    setBusyUid(request.uid);
    try {
      const result = await reviewAccessRequest(request.uid, decision);
      onToast(`Request ${result.status}`);
    } catch (reviewError) {
      onToast(`Could not review request: ${reviewError.message}`, 'error');
    } finally {
      setBusyUid('');
    }
  }

  const pendingCount = requests.filter((request) => request.status === 'pending').length;
  return <>
    <PageHeading eyebrow="ADMINISTRATION" title="User approvals" description="Review registration requests before granting workspace access." />
    {error && <div className="data-error" role="alert">{error}</div>}
    <section className="panel approvals-panel">
      <div className="panel-heading"><div><h2>Access requests</h2><p>{pendingCount} pending · {requests.length} total</p></div><span className="approval-lock">Workspace data stays private until approval</span></div>
      {loaded && !error && !requests.length && <div className="approval-empty"><span>✓</span><strong>No access requests</strong><small>New registrations will appear here.</small></div>}
      {!loaded && <div className="approval-empty">Loading access requests…</div>}
      {requests.length > 0 && <div className="approvals-table-wrap"><table className="approvals-table"><thead><tr><th>APPLICANT</th><th>EMAIL</th><th>REQUESTED</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody>{requests.map((request) => <tr key={request.id}><td><strong>{request.displayName || 'Unnamed user'}</strong><small className="approval-uid">{request.uid}</small></td><td>{request.email}</td><td>{request.createdAt?.toDate().toLocaleString() || 'Just now'}</td><td><span className={`request-status ${request.status}`}>{request.status}</span></td><td>{request.status === 'pending' ? <div className="approval-actions"><button className="button button-primary small-button" disabled={busyUid === request.uid} onClick={() => review(request, 'approve')}>{busyUid === request.uid ? 'Saving…' : 'Approve'}</button><button className="button button-outline small-button reject-button" disabled={busyUid === request.uid} onClick={() => review(request, 'reject')}>Reject</button></div> : <span className="reviewed-note">Reviewed</span>}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}

function Overview({ userName, jobs, reminders, onCreate, onOpenJob, onViewAll, onSeeAll, onDismiss }) {
  const active = jobs.filter((job) => job.progress < 100).length;
  return <>
    <PageHeading eyebrow="WEDNESDAY, 11 NOVEMBER 2026" title={`Good morning, ${userName}`} description="Here’s what’s happening across your projects today." action={<button className="button button-primary" onClick={onCreate}><span>＋</span> New job</button>} />
    <section className="stats-grid">
      <StatCard label="Active jobs" value={active} note="Across all project stages" icon="▤" tone="blue" trend="↗ 2 this month" />
      <StatCard label="Need attention" value={jobs.filter((job) => job.status !== 'On track').length} note="Jobs that may need a nudge" icon="⚑" tone="orange" trend="View jobs" />
      <StatCard label="Due this week" value="04" note="Milestones on your schedule" icon="◷" tone="purple" trend="2 due today" />
      <StatCard label="Awaiting approval" value="02" note="Quotes with your clients" icon="✓" tone="green" trend="Across 2 clients" />
    </section>
    <section className="overview-grid">
      <div className="panel jobs-panel">
        <div className="panel-heading"><div><h2>Recent jobs</h2><p>A snapshot of your active projects</p></div><button className="text-button" onClick={onViewAll}>View all jobs <span>→</span></button></div>
        <div className="table-scroll"><table className="jobs-table"><thead><tr><th>JOB</th><th>CLIENT</th><th>STAGE</th><th>PROGRESS</th><th>STATUS</th><th></th></tr></thead><tbody>
          {jobs.slice(0, 4).map((job) => <tr key={job.number} onClick={() => onOpenJob(job)}><td><div className="job-name-cell"><span className={`client-avatar ${job.color}`}>{job.initials}</span><span><strong>{job.name}</strong><small>{job.number}</small></span></div></td><td className="client-cell">{job.client}</td><td><span className="stage-pill">{job.stage}</span></td><td><div className="progress-cell"><div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div><span>{job.progress}%</span></div></td><td><Status status={job.status} /></td><td className="row-arrow">↗</td></tr>)}
          {!jobs.length && <tr><td colSpan="6"><div className="no-results"><strong>No jobs yet</strong><span>Create your first job to start tracking a project.</span></div></td></tr>}
        </tbody></table></div>
        <button className="mobile-view-all" onClick={onViewAll}>View all jobs →</button>
      </div>
      <div className="panel reminders-panel">
        <div className="panel-heading"><div><h2>Follow-ups</h2><p>Keep the important things moving</p></div><button className="icon-link" onClick={onSeeAll} aria-label="View all reminders">↗</button></div>
        <div className="reminder-list">{reminders.length ? reminders.slice(0, 3).map((item) => <Reminder key={item.id} item={item} onDismiss={() => onDismiss(item.id)} />) : <div className="all-clear"><span>✓</span><strong>You’re all caught up</strong><small>No outstanding follow-ups</small></div>}</div>
        <button className="reminder-footer" onClick={onSeeAll}>View all reminders <span>→</span></button>
      </div>
    </section>
    <section className="panel workflow-panel">
      <div className="panel-heading"><div><h2>Your workflow</h2><p>Jobs by project stage</p></div><span className="updated-note"><span /> Updated just now</span></div>
      <div className="workflow-stages">{stages.map((stage, index) => {
        const count = jobs.filter((job) => job.stage === stage).length;
        return <button className="workflow-stage" key={stage} onClick={() => {}}><span className={`stage-icon stage-${index}`}>{['◷', '✓', '⌘', '▧', '⚙', '↗'][index]}</span><span className="stage-name">{stage}</span><strong>{String(count).padStart(2, '0')}</strong><span className="stage-link">View jobs <span>→</span></span></button>;
      })}</div>
    </section>
    <div className="footer-note"><span>✳</span> Your projects, all in one place. Have a productive day.</div>
  </>;
}

function StatCard({ label, value, note, icon, tone, trend }) {
  return <div className="stat-card"><div className="stat-top"><span className="stat-label">{label}</span><span className={`stat-icon ${tone}`}>{icon}</span></div><strong className="stat-value">{value}</strong><div className="stat-bottom"><span>{note}</span><span className={`stat-trend ${tone}`}>{trend}</span></div></div>;
}

function Status({ status }) {
  const tone = status === 'On track' ? 'green' : status === 'At risk' ? 'orange' : 'red';
  return <span className={`status ${tone}`}><i />{status}</span>;
}

function Reminder({ item, onDismiss, onOpen }) {
  return <div className="reminder-item"><span className={`reminder-avatar ${item.color}`}>{item.initials}</span><div className="reminder-content"><span className={`reminder-label ${item.type}`}>{item.type === 'late' ? '● ' : '◷ '}{item.label}</span><strong>{item.title}</strong><span className="reminder-job">{item.job}</span><span className="reminder-note">{item.note}</span><div className="reminder-actions"><button onClick={onOpen || onDismiss}>{onOpen ? 'Open job' : 'Mark done'} <span>✓</span></button><button className="snooze" onClick={onDismiss}>Dismiss</button></div></div><button className="reminder-more" onClick={onDismiss} aria-label="Dismiss reminder">×</button></div>;
}

function JobsPage({ jobs, query, setQuery, filter, setFilter, onCreate, onOpenJob }) {
  return <>
    <PageHeading eyebrow="PROJECT WORKSPACE" title="Jobs" description="Manage every project from first quote to final delivery." action={<button className="button button-primary" onClick={onCreate}><span>＋</span> New job</button>} />
    <section className="panel list-panel">
      <div className="list-toolbar"><div className="filter-tabs">{['All jobs', 'On track', 'At risk', 'Needs attention'].map((value) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{value}<span>{value === 'All jobs' ? jobs.length : ''}</span></button>)}</div><label className="table-search"><span>⌕</span><input placeholder="Search jobs..." value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
      <div className="table-scroll"><table className="jobs-table full-table"><thead><tr><th>JOB</th><th>CLIENT</th><th>PROJECT LEAD</th><th>STAGE</th><th>DUE DATE</th><th>PROGRESS</th><th>STATUS</th><th /></tr></thead><tbody>
        {jobs.map((job) => <tr key={job.number} onClick={() => onOpenJob(job)}><td><div className="job-name-cell"><span className={`client-avatar ${job.color}`}>{job.initials}</span><span><strong>{job.name}</strong><small>{job.number}</small></span></div></td><td className="client-cell">{job.client}</td><td><span className="lead-avatar">{job.ownerInitials || job.owner?.slice(0, 2)}</span> <span className="lead-name">{job.owner || 'Unassigned'}</span></td><td><span className="stage-pill">{job.stage}</span></td><td className="due-date">{job.due}</td><td><div className="progress-cell"><div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div><span>{job.progress}%</span></div></td><td><Status status={job.status} /></td><td className="row-arrow">↗</td></tr>)}
        {!jobs.length && <tr><td colSpan="8"><div className="no-results"><strong>No jobs found</strong><span>Try changing your search or filters.</span></div></td></tr>}
      </tbody></table></div>
      <div className="table-end"><span>Showing {jobs.length} job{jobs.length === 1 ? '' : 's'}</span><span>Updated just now</span></div>
    </section>
  </>;
}

function SuppliersPage({ onToast }) {
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [supplierEditor, setSupplierEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    async function loadSuppliers() {
      try {
        await runTransaction(db, async (transaction) => {
          const seedRef = doc(db, 'meta', 'supplierDirectorySeed');
          const seed = await transaction.get(seedRef);
          if (seed.exists()) return;

          const supplierRefs = defaultSuppliers.map((supplier) => doc(db, 'suppliers', supplier.id));
          const existing = await Promise.all(supplierRefs.map((supplierRef) => transaction.get(supplierRef)));
          const timestamp = serverTimestamp();
          existing.forEach((snapshot, index) => {
            if (!snapshot.exists()) {
              const { id, ...supplier } = defaultSuppliers[index];
              transaction.set(supplierRefs[index], { ...supplier, createdAt: timestamp, updatedAt: timestamp });
            }
          });
          transaction.set(seedRef, { seededAt: timestamp });
        });

        if (!active) return;
        unsubscribe = onSnapshot(collection(db, 'suppliers'), (snapshot) => {
          setSuppliers(snapshot.docs
            .map((supplierDoc) => ({ id: supplierDoc.id, ...supplierDoc.data() }))
            .sort((first, second) => first.name.localeCompare(second.name)));
          setError('');
          setLoading(false);
        }, (snapshotError) => {
          setError(`Could not load suppliers: ${snapshotError.message}`);
          setLoading(false);
        });
      } catch (loadError) {
        if (active) {
          setError(`Could not load suppliers: ${loadError.message}`);
          setLoading(false);
        }
      }
    }

    loadSuppliers();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function saveSupplier(values) {
    const name = values.name.trim();
    if (!name) {
      onToast('Supplier name is required.', 'error');
      return;
    }

    setSaving(true);
    try {
      const parts = name.split(/\s+/).filter(Boolean);
      const initials = (parts.length > 1
        ? parts.slice(0, 2).map((part) => part[0]).join('')
        : (parts[0] || '').slice(0, 2)).toUpperCase();
      const supplier = {
        name,
        category: values.category.trim(),
        contact: values.contact.trim(),
        email: values.email.trim(),
        phone: values.phone.trim(),
        initials,
        color: supplierEditor.color || 'blue',
        updatedAt: serverTimestamp(),
      };

      if (supplierEditor.id) {
        await updateDoc(doc(db, 'suppliers', supplierEditor.id), supplier);
      } else {
        await addDoc(collection(db, 'suppliers'), { ...supplier, createdAt: serverTimestamp() });
      }
      setSupplierEditor(null);
      onToast(supplierEditor.id ? 'Supplier updated' : 'Supplier added');
    } catch (saveError) {
      onToast(`Could not save supplier: ${saveError.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function removeSupplier(supplier) {
    if (!window.confirm(`Delete ${supplier.name} from the supplier list?`)) return;
    setDeletingId(supplier.id);
    try {
      await deleteDoc(doc(db, 'suppliers', supplier.id));
      onToast('Supplier deleted');
    } catch (deleteError) {
      onToast(`Could not delete supplier: ${deleteError.message}`, 'error');
    } finally {
      setDeletingId('');
    }
  }

  return <>
    <PageHeading eyebrow="WORKSPACE DIRECTORY" title="Suppliers" description="Your preferred suppliers and the people you work with." action={<button className="button button-primary" onClick={() => setSupplierEditor({})}><span>＋</span> Add supplier</button>} />
    <div className="supplier-callout"><span className="callout-icon">✳</span><div><strong>Your go-to supplier list</strong><p>Keep trusted suppliers handy for every job and equipment order.</p></div><span className="callout-count">{suppliers.length} suppliers</span></div>
    {error && <div className="data-error" role="alert">{error}</div>}
    {loading && <div className="supplier-empty">Loading suppliers…</div>}
    {!loading && !error && !suppliers.length && <div className="supplier-empty">No suppliers yet. Add a supplier to get started.</div>}
    {!loading && <div className="supplier-grid">{suppliers.map((supplier) => <div className="panel supplier-card" key={supplier.id}><div className="supplier-top"><span className={`supplier-avatar ${supplier.color || 'blue'}`}>{supplier.initials || supplier.name.slice(0, 2).toUpperCase()}</span><div className="supplier-card-actions"><button className="supplier-edit" onClick={() => setSupplierEditor(supplier)}>Edit</button><button className="supplier-delete" disabled={deletingId === supplier.id} onClick={() => removeSupplier(supplier)}>{deletingId === supplier.id ? 'Deleting…' : 'Delete'}</button></div></div><h2>{supplier.name}</h2>{supplier.category && <span className="supplier-category">{supplier.category}</span>}<div className="supplier-divider" />{supplier.contact && <div className="supplier-contact"><span className="contact-icon">◎</span><div><strong>{supplier.contact}</strong><small>Supplier contact</small></div></div>}{supplier.email && <a href={`mailto:${supplier.email}`}><span>✉</span>{supplier.email}</a>}{supplier.phone && <a href={`tel:${supplier.phone}`}><span>⌕</span>{supplier.phone}</a>}</div>)}</div>}
    {supplierEditor && <SupplierModal supplier={supplierEditor} busy={saving} onClose={() => setSupplierEditor(null)} onSave={saveSupplier} />}
  </>;
}

function SupplierModal({ supplier, busy, onClose, onSave }) {
  function submit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    onSave({
      name: String(formData.get('name') || ''),
      category: String(formData.get('category') || ''),
      contact: String(formData.get('contact') || ''),
      email: String(formData.get('email') || ''),
      phone: String(formData.get('phone') || ''),
    });
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="create-modal supplier-modal" role="dialog" aria-modal="true" aria-labelledby="supplier-form-title"><div className="modal-heading"><div><div className="eyebrow">WORKSPACE DIRECTORY</div><h2 id="supplier-form-title">{supplier.id ? 'Edit supplier' : 'Add supplier'}</h2><p>Keep supplier and contact information up to date.</p></div><button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>×</button></div><form onSubmit={submit}><label className="form-field">Supplier name <span>*</span><input name="name" defaultValue={supplier.name || ''} maxLength="120" required autoFocus /></label><label className="form-field">Category<input name="category" defaultValue={supplier.category || ''} maxLength="120" placeholder="e.g. Pumps and dosing equipment" /></label><label className="form-field">Contact name<input name="contact" defaultValue={supplier.contact || ''} maxLength="120" /></label><label className="form-field">Email address<input name="email" type="email" defaultValue={supplier.email || ''} maxLength="254" /></label><label className="form-field">Phone number<input name="phone" type="tel" defaultValue={supplier.phone || ''} maxLength="50" /></label><div className="modal-footer"><span>Supplier details are shared with workspace members.</span><button type="button" className="button button-outline" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : supplier.id ? 'Save changes' : 'Add supplier'}</button></div></form></section></div>;
}

function EquipmentCatalogPage({ jobs, onOpenJob }) {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  useEffect(() => onSnapshot(
    collection(db, 'equipmentCatalog'),
    (snapshot) => {
      setItems(snapshot.docs.map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }))
        .sort((first, second) => first.description.localeCompare(second.description)));
      setError('');
    },
    (snapshotError) => setError(`Could not load the equipment catalogue: ${snapshotError.message}`),
  ), []);

  const filteredItems = items.filter((item) => [
    item.discipline, item.area, item.group, item.equipmentId, item.description,
    item.manufacturer, item.type, item.size, item.connection, item.material,
    item.elastomers, item.serialNumber, item.notes, item.plcIo,
    item.sourceJobNumber, item.sourceJobName,
  ].join(' ').toLowerCase().includes(search.toLowerCase()));

  return <>
    <PageHeading eyebrow="WORKSPACE LIBRARY" title="Equipment catalogue" description="Reusable equipment references saved from previous jobs. This is a catalogue, not a live stock count." />
    <section className="panel equipment-catalog-panel">
      <div className="equipment-catalog-toolbar">
        <div><strong>{items.length} saved item{items.length === 1 ? '' : 's'}</strong><span>Use past equipment from a job’s Equipment list.</span></div>
        <label className="table-search"><span>⌕</span><input aria-label="Search equipment catalogue" placeholder="Search equipment…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      {error && <div className="data-error" role="alert">{error}</div>}
      {!error && !items.length && <div className="equipment-empty"><span>▦</span><strong>No equipment saved yet</strong><small>Items added to a job’s equipment list will be saved here for reuse on future jobs.</small></div>}
      {!error && items.length > 0 && !filteredItems.length && <div className="equipment-empty"><strong>No matching equipment</strong><small>Try another description, supplier, type or job number.</small></div>}
      {filteredItems.length > 0 && <div className="equipment-table-scroll"><table className="equipment-table equipment-catalog-table"><thead><tr><th>NO.</th><th>DISCIPLINE</th><th>AREA</th><th>GRP.</th><th>ID.</th><th>DESCRIPTION</th><th>MANUFACTURER / SUPPLIER</th><th>TYPE</th><th>SIZE</th><th>CONNECTION</th><th>MATERIAL</th><th>ELASTOMERS</th><th>SERIAL NO.</th><th>NOTES</th><th>PLC I/O</th><th>PROGRESS</th><th>SOURCE JOB</th></tr></thead><tbody>{filteredItems.map((item) => {
        const sourceJob = jobs.find((job) => job.id === item.sourceJobId);
        return <tr key={item.id}><td>{item.number || '—'}</td><td>{item.discipline || 'Process Equipment'}</td><td>{item.area || '—'}</td><td>{item.group || '—'}</td><td>{item.equipmentId || '—'}</td><td><strong>{item.description}</strong></td><td>{item.manufacturer || '—'}</td><td>{item.type || '—'}</td><td>{item.size || '—'}</td><td>{item.connection || '—'}</td><td>{item.material || '—'}</td><td>{item.elastomers || '—'}</td><td>{item.serialNumber || '—'}</td><td>{item.notes || '—'}</td><td>{item.plcIo || '—'}</td><td><span className="equipment-progress">{item.progress || '—'}</span></td><td>{sourceJob ? <button className="equipment-source-link" onClick={() => onOpenJob(sourceJob)}>{item.sourceJobNumber || sourceJob.number}</button> : item.sourceJobNumber || item.sourceJobName || '—'}</td></tr>;
      })}</tbody></table></div>}
    </section>
  </>;
}

function RemindersPage({ reminders, onDismiss, onOpenJob }) {
  return <>
    <PageHeading eyebrow="STAY ON TOP OF THINGS" title="Reminders" description="Follow-ups and milestones that need a little attention." />
    <section className="panel reminders-page-panel"><div className="panel-heading"><div><h2>Upcoming & overdue</h2><p>{reminders.length} items to keep an eye on</p></div><span className="reminder-counter">{reminders.length} open</span></div>
      {reminders.length ? <div className="reminders-full-list">{reminders.map((item) => <Reminder key={item.id} item={item} onDismiss={() => onDismiss(item.id)} onOpen={() => onOpenJob(item.job.split(' · ')[0])} />)}</div> : <div className="all-clear large"><span>✓</span><strong>All caught up</strong><small>There are no outstanding follow-ups right now.</small></div>}
    </section>
  </>;
}

function JobEquipment({ job, user, onToast }) {
  const [items, setItems] = useState([]);
  const [equipmentCounters, setEquipmentCounters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [itemEditor, setItemEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [progressSavingId, setProgressSavingId] = useState('');
  const [catalogPicker, setCatalogPicker] = useState(false);
  const [catalogItems, setCatalogItems] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const groupedItems = useMemo(() => [...items].sort((first, second) => (
    String(first.group || '').localeCompare(String(second.group || ''), undefined, { numeric: true, sensitivity: 'base' })
    || Number(first.number) - Number(second.number)
  )), [items]);

  useEffect(() => onSnapshot(
    collection(db, 'jobs', job.id, 'equipment'),
    (snapshot) => {
      setItems(snapshot.docs.map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }))
        .sort((first, second) => Number(first.number) - Number(second.number)));
      setLoading(false);
      setError('');
    },
    (snapshotError) => {
      setError(`Could not load equipment: ${snapshotError.message}`);
      setLoading(false);
    },
  ), [job.id]);

  useEffect(() => onSnapshot(
    collection(db, 'jobs', job.id, 'equipmentCounters'),
    (snapshot) => setEquipmentCounters(snapshot.docs.map((counterDoc) => ({ id: counterDoc.id, ...counterDoc.data() }))),
    (snapshotError) => onToast(`Could not load equipment ID counters: ${snapshotError.message}`, 'error'),
  ), [job.id, onToast]);

  useEffect(() => {
    if (!catalogPicker) return undefined;
    setCatalogLoading(true);
    setCatalogError('');
    return onSnapshot(
      collection(db, 'equipmentCatalog'),
      (snapshot) => {
        setCatalogItems(snapshot.docs.map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }))
          .sort((first, second) => first.description.localeCompare(second.description)));
        setCatalogLoading(false);
      },
      (snapshotError) => {
        setCatalogError(`Could not load the equipment catalogue: ${snapshotError.message}`);
        setCatalogLoading(false);
      },
    );
  }, [catalogPicker]);

  const nextNumber = items.reduce((largest, item) => Math.max(largest, Number(item.number) || 0), 0) + 1;
  const visibleCatalogItems = catalogItems.filter((item) => [
    item.description, item.manufacturer, item.type, item.size, item.material,
    item.sourceJobNumber, item.sourceJobName,
  ].join(' ').toLowerCase().includes(catalogSearch.toLowerCase()));

  async function updateEquipmentProgress(item, progress) {
    setProgressSavingId(item.id);
    try {
      await updateDoc(doc(db, 'jobs', job.id, 'equipment', item.id), { progress });
    } catch (progressError) {
      onToast(`Could not update equipment progress: ${progressError.message}`, 'error');
    } finally {
      setProgressSavingId('');
    }
  }

  async function saveEquipment(values) {
    const description = values.description.trim();
    if (!description) {
      onToast('Equipment description is required.', 'error');
      return;
    }

    const equipment = {
      number: itemEditor.number || nextNumber,
      discipline: values.discipline,
      area: values.area.trim(),
      group: values.group.trim(),
      equipmentId: values.equipmentId.trim(),
      description,
      manufacturer: values.manufacturer.trim(),
      type: values.type.trim(),
      size: values.size.trim(),
      connection: values.connection.trim(),
      material: values.material.trim(),
      elastomers: values.elastomers.trim(),
      serialNumber: values.serialNumber.trim(),
      notes: values.notes.trim(),
      plcIo: values.plcIo.trim(),
      progress: values.progress,
    };

    setSaving(true);
    try {
      const timestamp = serverTimestamp();
      if (itemEditor.id) {
        const pairChanged = normalizeEquipmentCode(itemEditor.area) !== normalizeEquipmentCode(equipment.area)
          || normalizeEquipmentCode(itemEditor.group) !== normalizeEquipmentCode(equipment.group);
        let equipmentId = itemEditor.equipmentId || equipment.equipmentId;
        if (pairChanged) {
          equipmentId = await runTransaction(db, async (transaction) => {
            const oldArea = itemEditor.area || '';
            const oldGroup = itemEditor.group || '';
            const targetCounterRef = doc(db, 'jobs', job.id, 'equipmentCounters', equipmentCounterId(equipment.area, equipment.group));
            const oldCounterRef = doc(db, 'jobs', job.id, 'equipmentCounters', equipmentCounterId(oldArea, oldGroup));
            const [targetCounterSnapshot, oldCounterSnapshot] = await Promise.all([
              transaction.get(targetCounterRef),
              transaction.get(oldCounterRef),
            ]);
            const targetCounterData = targetCounterSnapshot.data();
            const targetUsed = getUsedEquipmentNumbers(targetCounterData, items, equipment.area, equipment.group, itemEditor.id);
            const nextNumber = getFirstAvailableEquipmentNumber(targetUsed);
            const targetWidth = getEquipmentIdWidth(targetCounterData, items, equipment.area, equipment.group, itemEditor.id, targetUsed);
            const nextId = String(nextNumber).padStart(targetWidth, '0');
            targetUsed.add(nextNumber);

            const otherItems = items.filter((existingItem) => existingItem.id !== itemEditor.id);
            const oldCounterData = oldCounterSnapshot.data();
            const oldUsed = getUsedEquipmentNumbers(oldCounterData, otherItems, oldArea, oldGroup);
            const oldNumber = getNumericEquipmentId(itemEditor.equipmentId);
            if (oldNumber !== null && !getEquipmentNumbers(otherItems, oldArea, oldGroup).includes(oldNumber)) {
              oldUsed.delete(oldNumber);
            }
            const oldWidth = getEquipmentIdWidth(oldCounterData, otherItems, oldArea, oldGroup, undefined, oldUsed);
            const updatedEquipment = { ...equipment, equipmentId: nextId, updatedAt: timestamp };
            writeEquipmentCounter(transaction, targetCounterRef, equipment.area, equipment.group, targetUsed, Math.max(targetWidth, nextId.length));
            writeEquipmentCounter(transaction, oldCounterRef, oldArea, oldGroup, oldUsed, oldWidth);
            transaction.update(doc(db, 'jobs', job.id, 'equipment', itemEditor.id), updatedEquipment);
            if (itemEditor.isCatalogSource && itemEditor.catalogId) {
              transaction.update(doc(db, 'equipmentCatalog', itemEditor.catalogId), { ...updatedEquipment });
            }
            return nextId;
          });
        } else {
          const batch = writeBatch(db);
          const updatedEquipment = { ...equipment, equipmentId, updatedAt: timestamp };
          batch.update(doc(db, 'jobs', job.id, 'equipment', itemEditor.id), updatedEquipment);
          if (itemEditor.isCatalogSource && itemEditor.catalogId) {
            batch.update(doc(db, 'equipmentCatalog', itemEditor.catalogId), { ...updatedEquipment });
          }
          await batch.commit();
        }
        onToast(`Equipment updated${equipmentId ? ` with ID ${equipmentId}` : ''}`);
      } else {
        const jobItemRef = doc(collection(db, 'jobs', job.id, 'equipment'));
        const catalogItemRef = itemEditor.catalogId ? null : doc(collection(db, 'equipmentCatalog'));
        const createdByName = user.displayName || user.email || 'Team member';
        const equipmentId = await runTransaction(db, async (transaction) => {
          const nextId = await reserveEquipmentId(transaction, job.id, equipment.area, equipment.group, items);
          const savedEquipment = { ...equipment, equipmentId: nextId };
          transaction.set(jobItemRef, {
            ...savedEquipment,
            catalogId: catalogItemRef?.id || itemEditor.catalogId,
            isCatalogSource: Boolean(catalogItemRef),
            createdBy: user.uid,
            createdByName,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          if (catalogItemRef) {
            transaction.set(catalogItemRef, {
              ...savedEquipment,
              sourceJobId: job.id,
              sourceJobNumber: job.number,
              sourceJobName: job.name,
              sourceClient: job.client,
              sourceEquipmentId: jobItemRef.id,
              createdBy: user.uid,
              createdByName,
              createdAt: timestamp,
              updatedAt: timestamp,
            });
          }
          return nextId;
        });
        onToast(itemEditor.catalogId
          ? `Catalogue item added to job with ID ${equipmentId}`
          : `Equipment added with ID ${equipmentId} and saved to the catalogue`);
      }
      setItemEditor(null);
    } catch (saveError) {
      onToast(`Could not save equipment: ${saveError.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  function addFromCatalog(item) {
    setCatalogPicker(false);
    setCatalogSearch('');
    setItemEditor({
      number: nextNumber,
      discipline: item.discipline || 'Process Equipment',
      area: '',
      group: '',
      equipmentId: '',
      description: item.description || '',
      manufacturer: item.manufacturer || '',
      type: item.type || '',
      size: item.size || '',
      connection: item.connection || '',
      material: item.material || '',
      elastomers: item.elastomers || '',
      serialNumber: '',
      notes: item.notes || '',
      plcIo: item.plcIo || '',
      progress: 'Awaiting Quote',
      catalogId: item.id,
      isCatalogSource: false,
    });
  }

  async function removeEquipment(item) {
    if (!window.confirm(`Remove ${item.description} from this job? Its catalogue reference will be kept for future reuse.`)) return;
    setDeletingId(item.id);
    try {
      const itemRef = doc(db, 'jobs', job.id, 'equipment', item.id);
      await runTransaction(db, async (transaction) => {
        const itemSnapshot = await transaction.get(itemRef);
        if (!itemSnapshot.exists()) return;

        const itemData = itemSnapshot.data();
        const number = getNumericEquipmentId(itemData.equipmentId);
        const area = itemData.area || '';
        const group = itemData.group || '';
        if (number === null) {
          transaction.delete(itemRef);
          return;
        }

        const counterRef = doc(db, 'jobs', job.id, 'equipmentCounters', equipmentCounterId(area, group));
        const counterSnapshot = await transaction.get(counterRef);
        const otherItems = items.filter((existingItem) => existingItem.id !== item.id);
        const counterData = counterSnapshot.data();
        const used = getUsedEquipmentNumbers(counterData, otherItems, area, group);
        const numberStillUsed = getEquipmentNumbers(otherItems, area, group).includes(number);
        if (!numberStillUsed) used.delete(number);
        const width = getEquipmentIdWidth(counterData, otherItems, area, group, undefined, used);

        transaction.delete(itemRef);
        writeEquipmentCounter(transaction, counterRef, area, group, used, width);
      });
      onToast('Equipment removed from job');
    } catch (deleteError) {
      onToast(`Could not remove equipment: ${deleteError.message}`, 'error');
    } finally {
      setDeletingId('');
    }
  }

  function exportEquipment() {
    if (!items.length) {
      onToast('There is no equipment to export yet.', 'error');
      return;
    }
    const columns = [
      ['number', 'No.'], ['area', 'Area'], ['group', 'Grp.'], ['equipmentId', 'ID.'],
      ['discipline', 'Discipline'], ['description', 'Description'], ['manufacturer', 'Manufact. /Supplier'],
      ['type', 'Type'], ['size', 'Size'], ['connection', 'Connect.'], ['material', 'Material'],
      ['elastomers', 'Elastomers'], ['serialNumber', 'Serial Nr.'], ['notes', 'Notes'],
      ['plcIo', 'PLC I/O'], ['progress', 'Progress'],
    ];
    const escapeCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = [
      columns.map(([, label]) => escapeCell(label)).join(','),
      ...items.map((item) => columns.map(([key]) => escapeCell(item[key])).join(',')),
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${job.number}-equipment-list.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return <>
    <section className="panel equipment-job-panel">
      <div className="panel-heading equipment-job-heading"><div><h2>Equipment list</h2><p>Capture P&amp;ID equipment details and procurement progress. New entries are added to the reusable catalogue.</p></div><div className="equipment-actions"><button className="button button-outline small-button" onClick={exportEquipment}>↓ Export CSV</button><button className="button button-outline small-button" onClick={() => { setCatalogSearch(''); setCatalogPicker(true); }}>Browse past items</button><button className="button button-primary small-button" onClick={() => setItemEditor({ number: nextNumber, progress: 'Awaiting Quote' })}>＋ Add equipment</button></div></div>
      <div className="equipment-template-note">Fields follow the Process Equipment and Instrumentation sheets in the provided workbook. Serial numbers and project progress are specific to this job.</div>
      {error && <div className="data-error" role="alert">{error}</div>}
      {loading && <div className="equipment-empty">Loading job equipment…</div>}
      {!loading && !error && !items.length && <div className="equipment-empty"><span>▦</span><strong>No equipment added yet</strong><small>Add an item or reuse equipment from a previous job.</small><button className="button button-primary" onClick={() => setItemEditor({ number: nextNumber, progress: 'Awaiting Quote' })}>＋ Add equipment</button></div>}
      {!loading && items.length > 0 && <div className="equipment-table-scroll"><table className="equipment-table job-equipment-table"><thead><tr><th aria-label="Progress indicator"></th><th>NO.</th><th>AREA</th><th>GRP.</th><th>ID.</th><th>DISCIPLINE</th><th>DESCRIPTION</th><th>MANUFACTURER / SUPPLIER</th><th>TYPE</th><th>SIZE</th><th>CONNECTION</th><th>MATERIAL</th><th>ELASTOMERS</th><th>SERIAL NO.</th><th>NOTES</th><th>PLC I/O</th><th>PROGRESS</th><th>ACTIONS</th></tr></thead><tbody>{groupedItems.map((item) => <tr key={item.id}><td><span className={`equipment-progress-indicator ${equipmentProgressClass(item.progress)}`} title={item.progress || 'No progress selected'} role="img" aria-label={`Progress status: ${item.progress || 'not set'}`} /></td><td>{item.number}</td><td>{item.area || '—'}</td><td>{item.group || '—'}</td><td>{item.equipmentId || '—'}</td><td>{item.discipline || 'Process Equipment'}</td><td><strong>{item.description}</strong></td><td>{item.manufacturer || '—'}</td><td>{item.type || '—'}</td><td>{item.size || '—'}</td><td>{item.connection || '—'}</td><td>{item.material || '—'}</td><td>{item.elastomers || '—'}</td><td>{item.serialNumber || '—'}</td><td>{item.notes || '—'}</td><td>{item.plcIo || '—'}</td><td><select className="equipment-progress-select" aria-label={`Progress for ${item.description || `item ${item.number}`}`} value={equipmentProgressOptions.includes(item.progress) ? item.progress : item.progress || 'Awaiting Quote'} disabled={progressSavingId === item.id} onChange={(event) => updateEquipmentProgress(item, event.target.value)}>{item.progress && !equipmentProgressOptions.includes(item.progress) && <option value={item.progress}>{item.progress}</option>}{equipmentProgressOptions.map((progress) => <option key={progress} value={progress}>{progress}</option>)}</select></td><td><div className="equipment-row-actions"><button onClick={() => setItemEditor(item)}>Edit</button><button disabled={deletingId === item.id} onClick={() => removeEquipment(item)}>{deletingId === item.id ? 'Removing…' : 'Remove'}</button></div></td></tr>)}</tbody></table></div>}
      {!loading && items.length > 0 && <div className="equipment-list-footer">{items.length} equipment item{items.length === 1 ? '' : 's'} · Catalogue references are retained if an item is removed from this job.</div>}
    </section>
    {itemEditor && <EquipmentModal item={itemEditor} items={items} counters={equipmentCounters} nextNumber={nextNumber} busy={saving} onClose={() => setItemEditor(null)} onSave={saveEquipment} />}
    {catalogPicker && <EquipmentCatalogPicker items={visibleCatalogItems} loading={catalogLoading} error={catalogError} busy={saving} search={catalogSearch} onSearch={setCatalogSearch} onClose={() => setCatalogPicker(false)} onUse={addFromCatalog} />}
  </>;
}

function EquipmentModal({ item, items, counters, nextNumber, busy, onClose, onSave }) {
  const [area, setArea] = useState(item.area || '');
  const [group, setGroup] = useState(item.group || '');
  const [equipmentId, setEquipmentId] = useState(item.equipmentId || getNextEquipmentId(area, group, items, counters, item.id));

  function nextIdFor(nextArea, nextGroup) {
    if (item.equipmentId
      && normalizeEquipmentCode(nextArea) === normalizeEquipmentCode(item.area)
      && normalizeEquipmentCode(nextGroup) === normalizeEquipmentCode(item.group)) {
      return item.equipmentId;
    }
    return getNextEquipmentId(nextArea, nextGroup, items, counters, item.id);
  }

  function submit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const value = (name) => String(formData.get(name) || '');
    onSave({
      discipline: value('discipline'),
      area: value('area'),
      group: value('group'),
      equipmentId: value('equipmentId'),
      description: value('description'),
      manufacturer: value('manufacturer'),
      type: value('type'),
      size: value('size'),
      connection: value('connection'),
      material: value('material'),
      elastomers: value('elastomers'),
      serialNumber: value('serialNumber'),
      notes: value('notes'),
      plcIo: value('plcIo'),
      progress: value('progress'),
    });
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="create-modal equipment-modal" role="dialog" aria-modal="true" aria-labelledby="equipment-form-title"><div className="modal-heading"><div><div className="eyebrow">JOB {item.number || nextNumber}</div><h2 id="equipment-form-title">{item.id ? 'Edit equipment' : 'Add equipment'}</h2><p>Enter the equipment identification, specification and tracking details.</p></div><button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>×</button></div><form onSubmit={submit}><div className="equipment-form-grid"><label className="form-field">No.<input value={item.number || nextNumber} readOnly /></label><label className="form-field">Discipline<select name="discipline" defaultValue={item.discipline || 'Process Equipment'}><option>Process Equipment</option><option>Instrumentation</option></select></label><label className="form-field">Area<input name="area" value={area} onChange={(event) => { const value = event.target.value; setArea(value); setEquipmentId(nextIdFor(value, group)); }} maxLength="40" /></label><label className="form-field">Group<input name="group" value={group} onChange={(event) => { const value = event.target.value; setGroup(value); setEquipmentId(nextIdFor(area, value)); }} maxLength="40" /></label><label className="form-field">ID<input name="equipmentId" value={equipmentId} readOnly /><small className="equipment-auto-id-note">Generated from Area and Group.</small></label><label className="form-field">Description <span>*</span><input name="description" defaultValue={item.description || ''} maxLength="160" required autoFocus /></label><label className="form-field">Manufacturer / Supplier<input name="manufacturer" defaultValue={item.manufacturer || ''} maxLength="120" /></label><label className="form-field">Type<input name="type" defaultValue={item.type || ''} maxLength="120" /></label><label className="form-field">Size<input name="size" defaultValue={item.size || ''} maxLength="80" /></label><label className="form-field">Connection<input name="connection" defaultValue={item.connection || ''} maxLength="80" /></label><label className="form-field">Material<input name="material" defaultValue={item.material || ''} maxLength="80" /></label><label className="form-field">Elastomers<input name="elastomers" defaultValue={item.elastomers || ''} maxLength="80" /></label><label className="form-field">Serial number<input name="serialNumber" defaultValue={item.serialNumber || ''} maxLength="100" /></label><label className="form-field">PLC I/O<input name="plcIo" defaultValue={item.plcIo || ''} maxLength="120" /></label><label className="form-field">Progress<select name="progress" defaultValue={item.progress || 'Awaiting Quote'}>{equipmentProgressOptions.map((option) => <option key={option}>{option}</option>)}</select></label><label className="form-field equipment-notes-field">Notes<textarea name="notes" defaultValue={item.notes || ''} maxLength="1000" rows="3" /></label></div><div className="modal-footer"><span>{item.id ? 'Edits are saved to this job.' : item.catalogId ? 'This is a copy of a catalogue item; changes will apply to this job only.' : 'New items are also saved to the reusable equipment catalogue.'}</span><button type="button" className="button button-outline" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : item.id ? 'Save changes' : 'Add equipment'}</button></div></form></section></div>;
}

function EquipmentCatalogPicker({ items, loading, error, busy, search, onSearch, onClose, onUse }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="create-modal equipment-picker" role="dialog" aria-modal="true" aria-labelledby="equipment-picker-title"><div className="modal-heading"><div><div className="eyebrow">REUSABLE EQUIPMENT</div><h2 id="equipment-picker-title">Add from past items</h2><p>Select an item to copy its specifications into this job.</p></div><button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>×</button></div><label className="table-search"><span>⌕</span><input aria-label="Search past equipment" placeholder="Search description, supplier or type…" value={search} onChange={(event) => onSearch(event.target.value)} /></label>{error && <div className="data-error" role="alert">{error}</div>}{loading && <div className="equipment-empty">Loading catalogue…</div>}{!loading && !error && !items.length && <div className="equipment-empty"><strong>No matching items</strong><small>Add equipment to jobs to build the reusable catalogue.</small></div>}{items.length > 0 && <div className="equipment-pick-list">{items.map((item) => <div className="equipment-pick-row" key={item.id}><div><strong>{item.description}</strong><span>{[item.manufacturer, item.type, item.size].filter(Boolean).join(' · ') || 'No specification details'}</span><small>From {item.sourceJobNumber || item.sourceJobName || 'a previous job'}</small></div><button className="button button-primary small-button" disabled={busy} onClick={() => onUse(item)}>{busy ? 'Adding…' : 'Use item'}</button></div>)}</div>}<div className="modal-footer"><button type="button" className="button button-outline" onClick={onClose} disabled={busy}>Close</button></div></section></div>;
}

function JobDetails({ job, user, onBack, onToast }) {
  const [tab, setTab] = useState('Overview');
  const [attachments, setAttachments] = useState([]);
  const [comments, setComments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [openingFileId, setOpeningFileId] = useState(null);
  const [preview, setPreview] = useState(null);

  useEffect(() => onSnapshot(
    firestoreQuery(collection(db, 'jobs', job.id, 'attachments'), orderBy('createdAt', 'desc')),
    (snapshot) => setAttachments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
    (error) => onToast(`Could not load attachments: ${error.message}`, 'error'),
  ), [job.id, onToast]);

  useEffect(() => onSnapshot(
    firestoreQuery(collection(db, 'jobs', job.id, 'comments'), orderBy('createdAt', 'asc')),
    (snapshot) => setComments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
    (error) => onToast(`Could not load discussion: ${error.message}`, 'error'),
  ), [job.id, onToast]);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview]);

  async function uploadFile(file) {
    if (file.size > 100 * 1024 * 1024) {
      onToast('Files must be smaller than 100 MB.', 'error');
      return;
    }
    setBusy(true);
    try {
      const path = `jobs/${job.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]/g, '_')}`;
      await uploadBytes(ref(storage, path), file, { contentType: file.type || 'application/octet-stream' });
      await addDoc(collection(db, 'jobs', job.id, 'attachments'), {
        name: file.name,
        path,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        uploadedBy: user.uid,
        uploadedByName: user.displayName || user.email || 'Team member',
        createdAt: serverTimestamp(),
      });
      onToast('File uploaded');
    } catch (error) {
      onToast(`Could not upload file: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openFile(file, shouldPreview) {
    setOpeningFileId(file.id);
    onToast(shouldPreview ? 'Preparing preview…' : 'Preparing download…');
    try {
      const blob = await getBlob(ref(storage, file.path));
      const url = URL.createObjectURL(blob);
      if (shouldPreview && (file.contentType === 'application/pdf' || file.contentType?.startsWith('image/'))) {
        setPreview({ name: file.name, type: file.contentType, url });
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (error) {
      onToast(`Could not open file: ${error.message}`, 'error');
    } finally {
      setOpeningFileId(null);
    }
  }

  async function addComment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const text = new FormData(form).get('comment').trim();
    if (!text) return;
    try {
      await addDoc(collection(db, 'jobs', job.id, 'comments'), {
        text,
        author: user.displayName || user.email || 'Team member',
        authorInitials: (user.displayName || user.email || 'TM').split(/[\s@.]+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
        authorId: user.uid,
        createdAt: serverTimestamp(),
      });
      form.reset();
    } catch (error) {
      onToast(`Could not post comment: ${error.message}`, 'error');
    }
  }

  const latestComment = comments[comments.length - 1];
  return <>
    <button className="back-link" onClick={onBack}>← Back to jobs</button>
    <div className="detail-heading"><div><div className="eyebrow">{job.number} <span className="crumb-dot">·</span> {job.client}</div><h1>{job.name}</h1><div className="detail-subtitle"><Status status={job.status} /><span>Project lead: <strong>{job.owner || 'Unassigned'}</strong></span><span>Due {job.due}</span></div></div><button className="button button-outline" onClick={() => onToast('Job options are coming soon')}>··· <span>More</span></button></div>
    <div className="detail-tabs">{['Overview', 'Documents', 'Equipment list', 'Discussion'].map((name) => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}{name === 'Discussion' && <span className="tab-count">{comments.length}</span>}</button>)}</div>
    {tab === 'Overview' && <div className="detail-grid"><div className="detail-main"><section className="panel detail-progress"><div className="panel-heading"><div><h2>Project progress</h2><p>Current stage: <strong>{job.stage}</strong></p></div><strong className="detail-percent">{job.progress}%</strong></div><div className="detail-progress-track"><span style={{ width: `${job.progress}%` }} /></div><div className="milestone-list">{stages.map((stage, index) => { const current = stage === job.stage; const completed = index < stages.indexOf(job.stage); return <div className={`milestone ${current ? 'current' : ''} ${completed ? 'completed' : ''}`} key={stage}><span className="milestone-dot">{completed ? '✓' : current ? '•' : ''}</span><div><strong>{stage}</strong><small>{completed ? 'Completed' : current ? 'In progress' : 'Not started'}</small></div>{current && <span className="milestone-tag">CURRENT</span>}</div>; })}</div></section>
      <ProjectFiles attachments={attachments} busy={busy} openingFileId={openingFileId} onUpload={uploadFile} onOpen={openFile} />
      </div><aside className="detail-side"><section className="panel detail-section"><div className="panel-heading"><div><h2>Project details</h2></div></div><DetailField label="Client" value={job.client} /><DetailField label="Job number" value={job.number} /><DetailField label="Project lead" value={job.owner || 'Unassigned'} /><DetailField label="Target delivery" value={job.due} /><DetailField label="Payment terms" value={job.paymentTerms || 'Not specified'} /></section><section className="panel detail-section"><div className="panel-heading"><div><h2>Latest discussion</h2><p>Keep your team in the loop</p></div><button className="icon-link" onClick={() => setTab('Discussion')}>↗</button></div>{latestComment ? <div className="comment-preview"><span className="comment-avatar">{latestComment.authorInitials}</span><div><strong>{latestComment.author} <small>{latestComment.createdAt?.toDate().toLocaleString() || 'Just now'}</small></strong><p>{latestComment.text}</p><button onClick={() => setTab('Discussion')}>View discussion →</button></div></div> : <div className="empty-discussion">No comments yet. Start the project conversation.</div>}</section></aside></div>}
    {tab === 'Documents' && <ProjectFiles attachments={attachments} busy={busy} openingFileId={openingFileId} onUpload={uploadFile} onOpen={openFile} />}
    {tab === 'Equipment list' && <JobEquipment job={job} user={user} onToast={onToast} />}
    {tab === 'Discussion' && <section className="panel discussion-panel"><div className="panel-heading"><div><h2>Project discussion</h2><p>Ideas, questions and decisions for this job.</p></div></div><div className="discussion-comments">{comments.map((comment) => <Comment key={comment.id} initials={comment.authorInitials} name={comment.author} time={comment.createdAt?.toDate().toLocaleString() || 'Just now'} text={comment.text} />)}{!comments.length && <div className="empty-discussion">No comments yet. Start the project conversation.</div>}</div><form className="comment-form" onSubmit={addComment}><span className="profile-avatar">{(user.displayName || user.email || 'TM').slice(0, 2).toUpperCase()}</span><input name="comment" aria-label="Write a comment" placeholder="Share an update or ask a question..." required /><button className="button button-primary">Send</button></form></section>}
    {preview && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { URL.revokeObjectURL(preview.url); setPreview(null); } }}><section className="file-preview" role="dialog" aria-modal="true" aria-label={preview.name}><div className="file-preview-header"><strong>{preview.name}</strong><button className="modal-close" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }} aria-label="Close preview">×</button></div>{preview.type.startsWith('image/') ? <img src={preview.url} alt={preview.name} /> : <iframe title={preview.name} src={preview.url} />}</section></div>}
  </>;
}

function ProjectFiles({ attachments, busy, openingFileId, onUpload, onOpen }) {
  return <section className="panel project-files"><div className="panel-heading"><div><h2>Project documents</h2><p>Upload and view quotations, PDFs, drawings and other project files.</p></div><label className={`button button-outline small-button upload-button${busy ? ' disabled' : ''}`}>＋ {busy ? 'Uploading…' : 'Upload file'}<input type="file" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ''; }} /></label></div>{attachments.length ? <div className="file-list">{attachments.map((file) => <div className="file-row" key={file.id}><span className="file-icon">▧</span><div className="file-meta"><strong>{file.name}</strong><small>{file.uploadedByName} · {file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`}</small></div>{(file.contentType === 'application/pdf' || file.contentType?.startsWith('image/')) && <button className="file-open" disabled={openingFileId === file.id} onClick={() => onOpen(file, true)}>{openingFileId === file.id ? 'Opening…' : 'View'}</button>}<button className="file-download" disabled={openingFileId === file.id} onClick={() => onOpen(file, false)}>{openingFileId === file.id ? 'Preparing…' : 'Download'}</button></div>)}</div> : <div className="empty-docs"><span>▧</span><div><strong>No documents yet</strong><small>Upload a quotation, drawing or other project file (up to 100 MB).</small></div></div>}</section>;
}

function DetailField({ label, value }) {
  return <div className="detail-field"><span>{label}</span><strong>{value}</strong></div>;
}

function Comment({ initials, name, time, text }) {
  return <div className="discussion-comment"><span className="comment-avatar">{initials}</span><div><strong>{name} <small>{time}</small></strong><p>{text}</p></div></div>;
}

function EmptyPage({ icon, title, text, action, onAction }) {
  return <section className="panel tab-placeholder page-placeholder"><span>{icon}</span><h2>{title}</h2><p>{text}</p><button className="button button-primary" onClick={onAction}>{action}</button></section>;
}

function CreateJobModal({ userName, onClose, onSubmit }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="modal-heading"><div><div className="eyebrow">PROJECT WORKSPACE</div><h2 id="create-title">Create a new job</h2><p>Start with the basics. You can fill in the rest as the project takes shape.</p></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div><form onSubmit={onSubmit}><label className="form-field">Project name <span>*</span><input name="name" placeholder="e.g. CIP Skid — Line 3" required autoFocus /></label><label className="form-field">Client <span>*</span><input name="client" placeholder="Client or company name" required /></label><div className="form-row"><label className="form-field">Project lead<input value={userName} readOnly /></label><label className="form-field">Target delivery<input type="date" name="due" /></label></div><label className="form-field">Notes <span className="optional">(optional)</span><textarea name="notes" placeholder="A short summary or anything to keep in mind..." rows="3" /></label><div className="modal-footer"><span>Job number will be assigned automatically</span><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button className="button button-primary">Create job <span>→</span></button></div></form></section></div>;
}

export default App;

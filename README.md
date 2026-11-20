# Workflow

React project workspace with Firebase Authentication, Cloud Firestore and Cloud Storage.

## Connect your Firebase project

1. In Firebase Console, register a Web App in your existing project and copy its web configuration.
2. In PowerShell, create your local environment file:

   ```powershell
   Copy-Item .env.example .env.local
   ```

3. Add the web app values to `.env.local` using the variable names already in that file. These are client configuration values, not service-account credentials. Never put a service-account key in this frontend.
4. In Firebase Console, enable **Authentication → Sign-in method → Email/Password**, create a **Cloud Firestore** database, and enable **Cloud Storage**.
5. Create or register the first administrator account. Firebase CLI login used for deployment does not authenticate the admin script. Set up Google Application Default Credentials with an account that has the **Firebase Authentication Admin** role:

   ```powershell
   gcloud auth application-default login
   $env:GCLOUD_PROJECT = "YOUR_FIREBASE_PROJECT_ID"
   node scripts\set-member-claim.mjs FIREBASE_AUTH_UID grant-admin
   ```

   Alternatively, set `GOOGLE_APPLICATION_CREDENTIALS` to a protected service-account JSON file outside this repository. Sign out and back in to refresh the administrator's claims. Never place service-account credentials in `.env.local` or the frontend.
6. Deploy the Firestore/Storage rules and callable approval function:

   ```powershell
   npx firebase-tools deploy --only firestore:rules,storage,functions --project YOUR_FIREBASE_PROJECT_ID
   ```

   The function is configured for Node.js 22. Cloud Functions deployment may require the Firebase project to be on the Blaze plan.
7. Users can register in the app. Requests are saved in `accessRequests/{uid}` and shown in the admin-only **User approvals** dashboard. Admins can approve or reject requests there; approved accounts receive the workspace access claim. To revoke access later, use `node scripts/set-member-claim.mjs FIREBASE_AUTH_UID revoke`.
8. Authenticated file previews/downloads use the Storage SDK. The CORS configuration includes the deployed Firebase Hosting origins and local development URLs. Apply it to your Storage bucket:

   ```powershell
   gcloud storage buckets update gs://YOUR_STORAGE_BUCKET --cors-file=cors.json
   ```

9. Restart the dev server with `npm run dev`, then register an account or sign in with an approved account.

Creating jobs, managing the supplier directory and equipment lists, adding discussion comments, and uploading files writes to Firestore/Storage. Workspace members can add, edit, and delete suppliers. Project equipment lists use the workbook's equipment and instrumentation fields, group rows by Grp. with items in the same group kept together, allow progress to be updated directly from each row, and show a color-coded progress dot beside each item number (red for Not Ordered/Booked Out, orange for Awaiting Quote and On-order, purple for Received Quote, sky blue for Onsite, and green for Received). They automatically assign the first available ID within each Area/Group pair (including reusing IDs when items are removed), export as CSV, and save new items to a reusable catalogue for future jobs. Equipment catalogue entries remain linked to their source job; the catalogue is not an on-hand stock count. The initial supplier list is seeded once into Firestore; changes persist for the whole workspace. Uploads are limited to 100 MB. PDFs and images can be previewed in the app; other drawing/CAD formats can be downloaded and opened in a compatible viewer.

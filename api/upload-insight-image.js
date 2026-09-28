// api/upload-insight-image.js
//
// Ported 2026-09-28 per Jaclyn — évolis's own copy of the VBC/Dazzle Dry
// reference file, verbatim except for REPORTS_FOLDER_ID (see the TODO
// below — this is the one brand-specific value that has to change, and I
// don't have évolis's real Drive folder ID to put here).
//
// Receives an image file (as base64 JSON from a browser <input type="file">
// + FileReader — no multipart parsing needed) and uploads it to a dedicated
// "Report Images" subfolder inside évolis's own Reports Archive Drive
// folder, then makes that one file public ("anyone with the link can
// view") and returns a direct, <img src>-embeddable URL.
//
// Finishes the "real upload coming later" TODO on the Accomplished cards'
// image fields (see the new What's Been Accomplished section on the
// Opportunities page) — those previously only accepted a URL someone had
// already hosted elsewhere by hand. Modeled closely on this repo's own
// existing api/upload-report.js Drive auth/upload pattern (same service
// account, same parent-folder approach), but PDFs never needed a public
// link (fetched through an authenticated endpoint instead) — images
// embedded directly in a PDF export via html2canvas/<img src> DO need a
// URL a plain <img> tag can load without any auth, hence the extra
// permissions.create() step below that upload-report.js doesn't have.
//
// Folder: creates "Report Images" under REPORTS_FOLDER_ID on first use if
// it doesn't already exist (checked/cached per cold start), rather than
// mixing raw image assets into the same folder as finished PDF reports.
//
// Auth reuses the same service-account env vars as every other évolis
// Drive cron: GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY.
//
// NOTE on payload size: base64 inflates the image by ~33%, and Vercel's
// default serverless body limit is 4.5MB — fine for a normal photo, but if
// uploads start failing with a 413, either compress client-side before
// sending or raise the limit for this route in vercel.json (same note as
// upload-report.js).

const { google } = require('googleapis');
const { Readable } = require('stream');

// TODO before deploying — this is VBC's own Drive folder ID, copied
// as-is from the reference file since I don't have évolis's real one.
// Replace with évolis's actual Reports Archive folder ID (the same
// folder api/upload-report.js already writes finished PDFs into) before
// this route is used, or uploads will land in the wrong brand's Drive.
const REPORTS_FOLDER_ID = '1z4ivJTBMVs6mttDO4E4c76OjknkFOg2P'; // <-- REPLACE with évolis's own folder ID
const IMAGES_SUBFOLDER_NAME = 'Report Images';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function driveClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/drive']
  );
  return google.drive({ version: 'v3', auth });
}

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

// Finds the "Report Images" subfolder under REPORTS_FOLDER_ID, creating it
// if it doesn't exist yet. Not cached across invocations (each cold start
// re-checks) — cheap (one list call) and avoids ever silently creating a
// second duplicate folder if a cache went stale.
async function getOrCreateImagesFolder(drive) {
  const existing = await drive.files.list({
    q: `'${REPORTS_FOLDER_ID}' in parents and name = '${IMAGES_SUBFOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  if (existing.data.files && existing.data.files.length > 0) {
    return existing.data.files[0].id;
  }
  const created = await drive.files.create({
    requestBody: {
      name: IMAGES_SUBFOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [REPORTS_FOLDER_ID],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  return created.data.id;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { filename, mimeType, imageBase64 } = req.body || {};
    if (!filename || !imageBase64) {
      return res.status(400).json({ error: 'filename and imageBase64 are required' });
    }
    const safeMimeType = (mimeType || '').toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(safeMimeType)) {
      return res.status(400).json({ error: `Unsupported image type: ${mimeType || '(none given)'} — allowed: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}` });
    }
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      console.error('[api/upload-insight-image] Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY env vars');
      return res.status(500).json({ error: 'Server is not configured for Drive uploads' });
    }

    const drive = driveClient();
    const buffer = Buffer.from(imageBase64, 'base64');
    const folderId = await getOrCreateImagesFolder(drive);

    // Always creates a new file (unlike upload-report.js's overwrite-by-
    // filename) — each upload is a distinct image someone is attaching to
    // a specific card slot, not a recurring monthly artifact with one
    // canonical name to replace in place. A timestamp prefix keeps
    // filenames collision-free without needing to inspect existing files.
    const uniqueName = `${Date.now()}-${filename}`;
    const created = await drive.files.create({
      requestBody: { name: uniqueName, parents: [folderId] },
      media: { mimeType: safeMimeType, body: bufferToStream(buffer) },
      fields: 'id',
      supportsAllDrives: true,
    });
    const fileId = created.data.id;

    // Make this ONE file public — the folder itself stays private/shared
    // only with the service account and whoever it's normally shared
    // with; only individual uploaded images get an "anyone with the link"
    // grant, since that's what a plain <img> tag (in the live dashboard
    // AND in the PDF export's html2canvas/direct-src rendering) needs to
    // load it without authentication.
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });

    // lh3.googleusercontent.com serves Drive images directly and
    // reliably for <img src> embedding — more consistent for this
    // purpose than the drive.google.com/uc?export=view URL format, which
    // can interstitial-warn on some file types/sizes.
    const url = `https://lh3.googleusercontent.com/d/${fileId}`;

    return res.status(200).json({ ok: true, fileId, url, filename: uniqueName });
  } catch (err) {
    console.error('[api/upload-insight-image]', err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
};

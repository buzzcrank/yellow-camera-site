// netlify/functions/upload.js
// Upload Yellow Camera clips to Google Drive using a service account

const { google } = require('googleapis');
const Busboy = require('busboy');
const { PassThrough } = require('stream');

// ---- Helpers ----

function bufferToStream(buffer) {
  const stream = new PassThrough();
  stream.end(buffer);
  return stream;
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const headers = event.headers || {};
    const contentType =
      headers['content-type'] ||
      headers['Content-Type'] ||
      '';

    if (!contentType.includes('multipart/form-data')) {
      return reject(
        new Error('Unsupported content type. Expected multipart/form-data.')
      );
    }

    const busboy = Busboy({ headers });
    const fields = {};
    const files = [];

    const body = Buffer.from(
      event.body || '',
      event.isBase64Encoded ? 'base64' : 'utf8'
    );

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (fieldname, file, filename, encoding, mimeType) => {
      const chunks = [];
      file.on('data', (data) => {
        chunks.push(data);
      });
      file.on('end', () => {
        const buffer = Buffer.concat(chunks);
        files.push({
          fieldname,
          filename,
          mimeType,
          buffer,
          size: buffer.length,
        });
      });
    });

    busboy.on('error', reject);

    busboy.on('finish', () => {
      resolve({ fields, files });
    });

    busboy.end(body);
  });
}

function isLikelyGoProName(filename) {
  if (!filename) return false;
  const upper = filename.toUpperCase();
  // Classic Hero 3 style: GOPR####.MP4
  if (/^GOPR\d{4}\.MP4$/.test(upper)) return true;
  // Other GoPro patterns (e.g. GH010001.MP4 style)
  if (/^G[HO]\d{2}\d{4}\.MP4$/.test(upper)) return true;
  return false;
}

async function getDriveClient() {
  const clientEmail = process.env.GDRIVE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GDRIVE_PRIVATE_KEY || '';
  const folderId = process.env.GDRIVE_FOLDER_ID;

  if (!clientEmail || !privateKeyRaw || !folderId) {
    throw new Error(
      'Missing one or more env vars: GDRIVE_CLIENT_EMAIL, GDRIVE_PRIVATE_KEY, GDRIVE_FOLDER_ID'
    );
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const drive = google.drive({ version: 'v3', auth });
  return { drive, folderId };
}

// ---- Netlify handler ----

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    // CORS preflight (future-proof if you ever cross domains)
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }),
    };
  }

  try {
    const { fields, files } = await parseMultipart(event);

    if (!files || files.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'No video files found in upload.',
        }),
      };
    }

    const { drive, folderId } = await getDriveClient();

    const nowIso = new Date().toISOString();
    const cameraId = fields.camera_id || 'unknown-camera';
    const cameraCode = fields.camera_code || 'no-code';
    const location = fields.location || 'unknown-location';
    const filmed = fields.date_filmed || '';
    const nickname = fields.name || '';
    const email = fields.email || '';
    const shareLink = fields.share_link || '';

    const safeCameraCode = cameraCode.replace(/[^A-Za-z0-9_-]/g, '');
    const timestampSlug = nowIso.replace(/[:.]/g, '-');

    const uploads = [];

    for (const f of files) {
      const original = f.filename || 'clip.mp4';
      const verified = isLikelyGoProName(original);

      const newName = `YC-${safeCameraCode || 'NA'}_${timestampSlug}_${original}`;

      const descriptionLines = [
        'Yellow Camera Project raw clip',
        `Original filename: ${original}`,
        `Camera ID: ${cameraId}`,
        `Camera code: ${cameraCode}`,
        `Location: ${location}`,
        filmed ? `Date filmed: ${filmed}` : '',
        nickname ? `Person: ${nickname}` : '',
        email ? `Contact: ${email}` : '',
        shareLink ? `Share link: ${shareLink}` : '',
        `Upload time: ${nowIso}`,
        `Verified Yellow Camera filename pattern: ${verified ? 'yes' : 'no'}`,
      ].filter(Boolean);

      const media = {
        mimeType: f.mimeType || 'video/mp4',
        body: bufferToStream(f.buffer),
      };

      const fileMetadata = {
        name: newName,
        parents: [folderId],
        description: descriptionLines.join('\n'),
      };

      const result = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, name',
      });

      uploads.push({
        id: result.data.id,
        name: result.data.name,
        originalName: original,
        verified,
        sizeBytes: f.size,
      });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        ok: true,
        message:
          'Upload complete. Your Yellow Camera clip has been saved. You can now pass the camera on.',
        uploadedCount: uploads.length,
        uploads,
      }),
    };
  } catch (err) {
    console.error('Upload error:', err);

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        ok: false,
        error: err.message || 'Unexpected error during upload.',
      }),
    };
  }
};

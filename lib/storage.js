const path = require('path');
const fs = require('fs');

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!useBlob && !fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

async function saveFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(ext) ? ext : '.png';
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;

  if (useBlob) {
    const { put } = require('@vercel/blob');
    const blob = await put(filename, file.buffer, {
      access: 'public',
      contentType: file.mimetype
    });
    return blob.url;
  }

  const dest = path.join(uploadDir, filename);
  fs.writeFileSync(dest, file.buffer);
  return `/uploads/${filename}`;
}

async function deleteFile(url) {
  if (useBlob) {
    if (!url || !url.includes('blob.vercel-storage.com')) return;
    const { del } = require('@vercel/blob');
    await del(url).catch(() => {});
    return;
  }
  if (!url || !url.startsWith('/uploads/')) return;
  const p = path.join(uploadDir, path.basename(url));
  fs.unlink(p, () => {});
}

module.exports = { saveFile, deleteFile, useBlob };

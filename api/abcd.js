import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const type = req.query.type || 'dict';
  const file = req.query.file;
  if (!file) return res.status(400).send('file パラメータが必要です');

  const baseDir = type === 'dict' ? path.join(process.cwd(), 'dict') : path.join(process.cwd(), 'data');
  const filePath = path.join(baseDir, file);

  fs.readFile(filePath, type === 'data' ? 'utf8' : null, (err, data) => {
    if (err) return res.status(404).send('Not found');

    if (type === 'data') res.setHeader('Content-Type', 'application/json');
    else res.setHeader('Content-Type', 'application/gzip');

    res.send(data);
  });
}
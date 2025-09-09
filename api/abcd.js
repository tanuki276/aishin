import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const file = req.query.file || 'base.dat.gz';
  const filePath = path.join(process.cwd(), 'dict', file);

  fs.readFile(filePath, (err, data) => {
    if (err) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'application/gzip');
    res.send(data);
  });
}
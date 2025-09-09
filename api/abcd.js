import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const type = req.query.type || 'dict';  // 'dict' か 'data'
  const file = req.query.file;            // ファイル名必須

  if (!file) return res.status(400).send('file パラメータが必要です');

  // フォルダを type に応じて切り替え
  let baseDir;
  if (type === 'dict') baseDir = path.join(process.cwd(), 'dict');
  else if (type === 'data') baseDir = path.join(process.cwd(), 'data');
  else return res.status(400).send('無効な type パラメータ');

  const filePath = path.join(baseDir, file);

  // データ取得
  fs.readFile(filePath, type === 'data' ? 'utf8' : null, (err, data) => {
    if (err) return res.status(404).send('Not found');

    if (type === 'data') res.setHeader('Content-Type', 'application/json');
    else res.setHeader('Content-Type', 'application/gzip');

    res.send(data);
  });
}
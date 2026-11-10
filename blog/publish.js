// 사용: node blog/publish.js
// env: WP_URL, WP_USER, WP_APP_PASSWORD, WP_STATUS(draft|publish, 기본 draft)
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const postsDir = path.join(dir, 'posts');
const stateFile = path.join(dir, 'published.json');
const naverDir = path.join(dir, 'out', 'naver');
const { WP_URL, WP_USER, WP_APP_PASSWORD, WP_STATUS = 'draft' } = process.env;

const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
fs.mkdirSync(naverDir, { recursive: true });

async function main() {
  const files = fs.readdirSync(postsDir).filter(f => f.endsWith('.html') && !state[f]);
  if (!files.length) return console.log('새 글 없음');
  for (const f of files) {
    const html = fs.readFileSync(path.join(postsDir, f), 'utf8');
    const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (!m) { console.error(`${f}: <h1> 제목 없음, 건너뜀`); continue; }
    const title = m[1].replace(/<[^>]+>/g, '').trim();
    const content = html.replace(m[0], '').trim();

    // 네이버: 공식 발행 API 없음 → 붙여넣기용 파일만 생성
    fs.writeFileSync(path.join(naverDir, f), `<h1>${title}</h1>\n${content}`);

    if (!WP_URL || !WP_USER || !WP_APP_PASSWORD) { console.log(`${f}: WP 환경변수 없음, 네이버용만 생성`); continue; }
    const res = await fetch(`${WP_URL.replace(/\/$/, '')}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64'),
      },
      body: JSON.stringify({ title, content, status: WP_STATUS }),
    });
    if (!res.ok) { console.error(`${f}: WP 실패 ${res.status} ${await res.text()}`); process.exitCode = 1; continue; }
    const data = await res.json();
    state[f] = { wp_id: data.id, link: data.link, at: new Date().toISOString() };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
    console.log(`${f}: WP ${WP_STATUS} → ${data.link}`);
  }
}
main();

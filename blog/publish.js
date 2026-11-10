// 글: blog/posts/<blog-id>/*.html (첫 줄 <h1>제목</h1>)
// 설정: blog/blogs.json  { "<blog-id>": { "wp": "SUFFIX", "naver": true } }
// 시크릿: WP_URL_<SUFFIX>, WP_USER_<SUFFIX>, WP_APP_PASSWORD_<SUFFIX>, WP_STATUS_<SUFFIX>(draft|publish, 기본 draft)
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const blogs = JSON.parse(fs.readFileSync(path.join(dir, 'blogs.json'), 'utf8'));
const stateFile = path.join(dir, 'published.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
// Actions: SECRETS(JSON) / 로컬: 일반 env
const env = { ...process.env, ...(process.env.SECRETS ? JSON.parse(process.env.SECRETS) : {}) };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');

async function main() {
  for (const [id, cfg] of Object.entries(blogs)) {
    const postsDir = path.join(dir, 'posts', id);
    if (!fs.existsSync(postsDir)) continue;
    for (const f of fs.readdirSync(postsDir).filter(f => f.endsWith('.html'))) {
      const key = `${id}/${f}`;
      const s = (state[key] ||= {});
      const html = fs.readFileSync(path.join(postsDir, f), 'utf8');
      const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
      if (!m) { console.error(`${key}: <h1> 제목 없음, 건너뜀`); continue; }
      const title = m[1].replace(/<[^>]+>/g, '').trim();
      const content = html.replace(m[0], '').trim();

      // 네이버: 공식 발행 API 없음 → 붙여넣기용 파일 생성 (repo에 커밋됨)
      if (cfg.naver && !s.naver) {
        const out = path.join(dir, 'out', 'naver', id);
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, f), `<h1>${title}</h1>\n${content}`);
        s.naver = true;
        console.log(`${key}: 네이버용 생성`);
      }

      if (cfg.wp && !s.wp) {
        const sfx = cfg.wp;
        const url = env[`WP_URL_${sfx}`], user = env[`WP_USER_${sfx}`], pw = env[`WP_APP_PASSWORD_${sfx}`];
        if (!url || !user || !pw) { console.error(`${key}: WP_*_${sfx} 시크릿 없음, 건너뜀`); continue; }
        const status = env[`WP_STATUS_${sfx}`] || 'draft';
        const res = await fetch(`${url.replace(/\/$/, '')}/wp-json/wp/v2/posts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64'),
          },
          body: JSON.stringify({ title, content, status }),
        });
        if (!res.ok) { console.error(`${key}: WP 실패 ${res.status} ${await res.text()}`); process.exitCode = 1; continue; }
        const data = await res.json();
        s.wp = { id: data.id, link: data.link, status, at: new Date().toISOString() };
        console.log(`${key}: WP ${status} → ${data.link}`);
      }
      save();
    }
  }
}
main();

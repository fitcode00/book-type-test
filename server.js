/*
  책 유형 테스트 서비스용 로컬/배포 서버 (Node.js 기본 모듈만 사용, 별도 설치 불필요)

  실행 방법:
    node server.js
  그 다음 브라우저에서 http://localhost:3000 접속

  배포 시:
    - ALADIN_TTB_KEY는 아래처럼 환경변수로 넘기는 걸 권장 (코드에 하드코딩하지 않기)
      예) Windows: set ALADIN_TTB_KEY=발급받은키 && node server.js
      예) Render/Railway 등: 대시보드의 Environment Variables에 ALADIN_TTB_KEY 등록
    - 환경변수가 없으면 아래 FALLBACK_KEY를 사용함 (로컬 테스트 편의용, 배포 시엔 꼭 환경변수로 교체)

  용도:
  - index.html(책유형테스트_프로토타입.html)과 캐릭터 이미지(characters/*.png) 등 정적 파일 서빙
  - /aladin-api 요청을 받아 서버에서 TTBKey를 붙여 알라딘 Open API를 대신 호출
    (키가 클라이언트 JS에 노출되지 않음, 브라우저 CORS도 우회됨)
  - 동일한 도서 검색 결과는 메모리에 캐싱해서 알라딘 API 호출 횟수(일 5,000회 제한)를 아낌
*/

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HTML_FILE = '책유형테스트_프로토타입.html'; // 같은 폴더에 있어야 함
const FALLBACK_KEY = 'ttbfitcode000904001'; // 로컬 테스트용 기본값. 배포 시 ALADIN_TTB_KEY 환경변수로 덮어쓰기 권장
const ALADIN_TTB_KEY = process.env.ALADIN_TTB_KEY || FALLBACK_KEY;

// AI 상담 기능용 Claude API 키. 환경변수로 넘기기 (코드에 하드코딩 금지)
//   예) Windows: set ANTHROPIC_API_KEY=발급받은키 && node server.js
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

// 결제 링크 방식 구독 (사업자등록+PG 계약 전이라 자동결제는 아직 못 붙임).
// 토스페이먼츠/카카오페이 등에서 만든 결제 링크 URL을 여기 넣으면 구독 화면에 노출됨.
const PAYMENT_LINK_URL = process.env.PAYMENT_LINK_URL || '';
const PAYMENT_PRICE_LABEL = process.env.PAYMENT_PRICE_LABEL || '월 3,900원';
// 결제 확인 후 /admin 페이지에서 이 키를 입력해야 구독을 수동으로 열어줄 수 있음 (자동결제 붙기 전 임시 방법)
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// 계좌이체 + 입금문자 자동매칭 방식 구독 (폰 문자 기반, 폰이 꺼져있으면 지연됨 - 페이앱 붙기 전 임시용/폴백).
const BANK_NAME = process.env.BANK_NAME || '';
const BANK_ACCOUNT_NUMBER = process.env.BANK_ACCOUNT_NUMBER || '';
const BANK_ACCOUNT_HOLDER = process.env.BANK_ACCOUNT_HOLDER || '';
const PAYMENT_AMOUNT = Number(process.env.PAYMENT_AMOUNT) || 3900;
// 문자포워딩 앱(예: MacroDroid)이 /api/deposit-webhook 호출할 때 넣어야 하는 비밀키
const DEPOSIT_WEBHOOK_KEY = process.env.DEPOSIT_WEBHOOK_KEY || '';

// 페이앱(PayApp) API 연동 - 폰/PG가맹 없이도 결제완료를 서버가 바로 웹훅으로 통보받음 (제일 우선순위 높은 방식).
// userid는 페이앱 로그인 아이디, linkkey/linkval은 판매자 관리사이트 '설정 > 연동정보'에서 확인.
const PAYAPP_USERID = process.env.PAYAPP_USERID || '';
const PAYAPP_LINKKEY = process.env.PAYAPP_LINKKEY || '';
const PAYAPP_LINKVAL = process.env.PAYAPP_LINKVAL || '';
// 페이앱이 결제완료를 통보할 우리 서버 주소. 예) https://book-type-test.onrender.com/api/payapp-webhook
const PAYAPP_FEEDBACK_URL = process.env.PAYAPP_FEEDBACK_URL || '';

function readRawBody(req){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// 페이앱 REST API 호출 (form-urlencoded POST). 응답도 form-urlencoded로 옴.
function callPayApp(params){
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(params).toString();
    const options = {
      hostname: 'api.payapp.kr',
      path: '/oapi/apiLoad.html',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const apiReq = https.request(options, (apiRes) => {
      const chunks = [];
      apiRes.on('data', (c) => chunks.push(c));
      apiRes.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const result = {};
        new URLSearchParams(bodyText).forEach((v, k) => { result[k] = v; });
        resolve(result);
      });
    });
    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

// 사업자등록/결제 붙기 전까지 AI 상담을 전원 무료로 열어두는 임시 스위치.
// 환경변수 FREE_FOR_ALL=true 로 켜고, 나중에 결제 붙이면 지우거나 false로.
const FREE_FOR_ALL = process.env.FREE_FOR_ALL === 'true';

// 월간 큐레이션 푸시 알림. web-push 패키지가 없으면(npm install 전) 조용히 비활성화됨.
let webpush = null;
try { webpush = require('web-push'); } catch (e) { /* npm install web-push 필요 */ }
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:fitcode00@gmail.com';
if (webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

/* ---------- 회원 데이터 저장소 ----------
   Render 무료 플랜은 파일시스템이 임시라 재배포/재시작마다 로컬 파일이 날아감.
   FIREBASE_* 환경변수가 있으면 Firestore에 저장(영구 보존), 없으면 로컬 JSON 파일로 폴백(로컬 개발용). */
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || '';
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || '';
// Render 환경변수 입력칸은 보통 한 줄이라 개행이 \n 문자로 들어옴 -> 실제 개행으로 되돌림
const FIREBASE_PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const USE_FIRESTORE = !!(FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY);

function base64url(buf){
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 구글 서비스계정으로 OAuth2 access token 발급 (JWT bearer flow). 메모리에 캐싱, 만료 임박 시 재발급.
let googleTokenCache = { token: '', expiresAt: 0 };
function getGoogleAccessToken(){
  if (googleTokenCache.token && Date.now() < googleTokenCache.expiresAt - 60000) {
    return Promise.resolve(googleTokenCache.token);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  signer.end();
  const signature = base64url(signer.sign(FIREBASE_PRIVATE_KEY));
  const jwt = `${header}.${claim}.${signature}`;
  const payload = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) },
    };
    const apiReq = https.request(options, (apiRes) => {
      const chunks = [];
      apiRes.on('data', (c) => chunks.push(c));
      apiRes.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* noop */ }
        if (!data || !data.access_token) { reject(new Error((data && data.error_description) || 'Google 인증 실패')); return; }
        googleTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
        resolve(data.access_token);
      });
    });
    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

// JS 값 <-> Firestore REST 문서 형식 변환
function toFirestoreValue(v){
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  return { mapValue: { fields: toFirestoreFields(v) } };
}
function toFirestoreFields(obj){
  const fields = {};
  Object.keys(obj || {}).forEach((k) => { fields[k] = toFirestoreValue(obj[k]); });
  return fields;
}
function fromFirestoreValue(v){
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) return fromFirestoreFields(v.mapValue.fields || {});
  return null;
}
function fromFirestoreFields(fields){
  const obj = {};
  Object.keys(fields || {}).forEach((k) => { obj[k] = fromFirestoreValue(fields[k]); });
  return obj;
}

function firestoreRequest(method, pathAndQuery, body){
  return getGoogleAccessToken().then((token) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${pathAndQuery}`,
      method,
      headers: { Authorization: `Bearer ${token}` },
    };
    if (payload) { options.headers['Content-Type'] = 'application/json'; options.headers['Content-Length'] = Buffer.byteLength(payload); }
    const apiReq = https.request(options, (apiRes) => {
      const chunks = [];
      apiRes.on('data', (c) => chunks.push(c));
      apiRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { /* noop */ }
        if (apiRes.statusCode === 404) { resolve(null); return; }
        if (apiRes.statusCode >= 200 && apiRes.statusCode < 300) { resolve(data); return; }
        reject(new Error((data && data.error && data.error.message) || `Firestore 오류 (${apiRes.statusCode})`));
      });
    });
    apiReq.on('error', reject);
    if (payload) apiReq.write(payload);
    apiReq.end();
  }));
}

function loadUsersFile(){
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveUsersFile(users){
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// 회원 한 명 조회/저장/전체목록 - USE_FIRESTORE 여부에 따라 Firestore 또는 로컬 파일 사용
async function getUser(email){
  if (USE_FIRESTORE) {
    const doc = await firestoreRequest('GET', `users/${encodeURIComponent(email)}`);
    return doc ? fromFirestoreFields(doc.fields) : null;
  }
  return loadUsersFile()[email] || null;
}
async function setUser(email, userObj){
  if (USE_FIRESTORE) {
    await firestoreRequest('PATCH', `users/${encodeURIComponent(email)}`, { fields: toFirestoreFields(userObj) });
    return;
  }
  const users = loadUsersFile();
  users[email] = userObj;
  saveUsersFile(users);
}
async function listAllUsersMap(){
  if (!USE_FIRESTORE) return loadUsersFile();
  const result = {};
  let pageToken = '';
  do {
    const qs = 'pageSize=300' + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const data = await firestoreRequest('GET', `users?${qs}`);
    ((data && data.documents) || []).forEach((doc) => {
      const email = decodeURIComponent(doc.name.split('/').pop());
      result[email] = fromFirestoreFields(doc.fields);
    });
    pageToken = (data && data.nextPageToken) || '';
  } while (pageToken);
  return result;
}

// 계좌이체 결제 요청/입금문자 매칭 기록 (data/payments.json)
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');
function loadPayments(){
  try { return JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8')); } catch (e) { return { pending: [], unmatched: [] }; }
}
function savePayments(data){
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(data, null, 2));
}
function makeMatchCode(){
  return crypto.randomBytes(2).toString('hex').toUpperCase(); // 예: A3F9
}
async function activateSubscription(email, days){
  const user = await getUser(email);
  if (!user) return null;
  user.subscription = {
    active: true,
    plan: 'paid',
    expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
  };
  await setUser(email, user);
  return user.subscription;
}

// 세션은 서버 메모리에 안 두고, 서명된 쿠키(email+만료시각을 HMAC으로 서명)로 대체함.
// 이러면 재배포/재시작해도 로그인이 안 풀림 (검증이 서명 확인만으로 되니까 서버가 뭘 기억할 필요가 없음).
const SESSION_SECRET = process.env.SESSION_SECRET || 'local-dev-secret-change-in-production';
if (!process.env.SESSION_SECRET) console.log('[주의] SESSION_SECRET 환경변수가 없어서 로컬 기본값 사용 중. 배포 전 꼭 설정할 것 (안 그러면 서버 재시작마다 기존 로그인들이 전부 무효화됨).');

function makeSalt(){ return crypto.randomBytes(16).toString('hex'); }
function makeToken(){ return crypto.randomBytes(24).toString('hex'); }
function hashPassword(password, salt){ return crypto.scryptSync(password, salt, 64).toString('hex'); }

function makeSessionToken(email){
  const payload = base64url(JSON.stringify({ email, exp: Date.now() + 30 * 86400000 }));
  const sig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}
function verifySessionToken(token){
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!data.email || !data.exp || Date.now() > data.exp) return null;
    return data.email;
  } catch (e) { return null; }
}

function parseCookies(req){
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

async function getSessionUser(req){
  const email = verifySessionToken(parseCookies(req).session);
  if (!email) return null;
  const user = await getUser(email);
  return user ? Object.assign({ email }, user) : null;
}

function readJsonBody(req){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // 너무 큰 요청 방지
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders){
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}));
  res.end(JSON.stringify(obj));
}

/* ---------- AI 상담: Claude API 호출 ---------- */
function callClaude(systemPrompt, messages){
  return new Promise((resolve, reject) => {
    if (!ANTHROPIC_API_KEY) {
      reject(new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았어요. (AI 상담 테스트를 위해 발급받은 키를 설정해주세요)'));
      return;
    }
    const payload = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages,
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const apiReq = https.request(options, (apiRes) => {
      const chunks = [];
      apiRes.on('data', (chunk) => chunks.push(chunk));
      apiRes.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (apiRes.statusCode >= 200 && apiRes.statusCode < 300) {
            const text = (data.content && data.content[0] && data.content[0].text) || '';
            resolve(text);
          } else {
            reject(new Error((data.error && data.error.message) || `Claude API 오류 (${apiRes.statusCode})`));
          }
        } catch (e) { reject(e); }
      });
    });
    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// 표지 검색 결과 캐시: "쿼리|쿼리타입" -> cover URL(문자열) 또는 null(결과없음)
const coverCache = new Map();

function fetchAladin(query, queryType){
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      ttbkey: ALADIN_TTB_KEY,
      Query: query,
      QueryType: queryType,
      MaxResults: '1',
      start: '1',
      SearchTarget: 'Book',
      output: 'js',
      Version: '20131101',
      Cover: 'Big',
    });
    const target = 'https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?' + params.toString();
    https.get(target, (proxyRes) => {
      let body = '';
      proxyRes.on('data', (chunk) => (body += chunk));
      proxyRes.on('end', () => {
        let cover = null;
        let parseError = null;
        let data = null;
        try {
          data = JSON.parse(body);
          cover = (data.item && data.item[0] && data.item[0].cover) || null;
        } catch (e) { parseError = String(e); }
        resolve({ cover, raw: body.slice(0, 800), parseError, upstreamStatus: proxyRes.statusCode });
      });
    }).on('error', (err) => resolve({ cover: null, error: String(err) }));
  });
}

// AI 상담이 추천한 책의 알라딘 TTB 구매(검색)링크. itemId 조회용 API 호출은 안 함
// (배포된 서버 IP에서는 알라딘이 API를 막아서 - 위 fetchAladin과 같은 이유). 대신
// 검색결과 페이지로 보내는 URL만 만듦 - 이것도 TTBKey가 붙어있어서 제휴 추적은 됨.
function buildSearchTTBLink(title){
  // 저자는 AI가 틀리게 말할 때가 있어서(예: 엉뚱한 역자/오기) 검색어에 안 섞음.
  // 저자까지 넣으면 오히려 검색결과가 0건이 되는 경우가 있어 제목만으로 검색.
  return `https://www.aladin.co.kr/search/wsearchresult.aspx?SearchTarget=Book&SearchWord=${encodeURIComponent(title)}&TTBKey=${ALADIN_TTB_KEY}`;
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    console.error('요청 처리 중 오류:', e);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
});

async function handleRequest(req, res){
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/aladin-api') {
    const query = url.searchParams.get('query') || '';
    const queryType = url.searchParams.get('queryType') || 'Keyword';
    const debug = url.searchParams.get('debug') === '1';
    const cacheKey = `${query}|${queryType}`;

    let result;
    if (coverCache.has(cacheKey) && !debug) {
      result = { cover: coverCache.get(cacheKey) };
    } else {
      result = await fetchAladin(query, queryType);
      coverCache.set(cacheKey, result.cover);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(debug ? result : { cover: result.cover }));
    return;
  }

  // ---- 회원가입 ----
  if (url.pathname === '/api/signup' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    if (!body || !body.email || !body.password) { sendJson(res, 400, { error: '이메일/비밀번호를 입력해주세요.' }); return; }
    const email = String(body.email).trim().toLowerCase();
    if (body.password.length < 6) { sendJson(res, 400, { error: '비밀번호는 6자 이상으로 해주세요.' }); return; }
    if (await getUser(email)) { sendJson(res, 409, { error: '이미 가입된 이메일이에요.' }); return; }
    const salt = makeSalt();
    await setUser(email, {
      passwordHash: hashPassword(body.password, salt),
      salt,
      createdAt: new Date().toISOString(),
      resultType: null,
      reviews: [],
      pushSubscription: null,
      // 결제 확인되면 /admin에서 true로 바뀜 (자동결제 붙기 전까지의 임시 방법)
      subscription: { active: false, plan: 'free', expiresAt: null },
    });
    const token = makeSessionToken(email);
    sendJson(res, 200, { ok: true, email }, { 'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=2592000` });
    return;
  }

  // ---- 로그인 ----
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    if (!body || !body.email || !body.password) { sendJson(res, 400, { error: '이메일/비밀번호를 입력해주세요.' }); return; }
    const email = String(body.email).trim().toLowerCase();
    const user = await getUser(email);
    if (!user || hashPassword(body.password, user.salt) !== user.passwordHash) {
      sendJson(res, 401, { error: '이메일 또는 비밀번호가 맞지 않아요.' });
      return;
    }
    const token = makeSessionToken(email);
    sendJson(res, 200, { ok: true, email }, { 'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=2592000` });
    return;
  }

  // ---- 로그아웃 ----
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });
    return;
  }

  // ---- 로그인 상태 확인 ----
  if (url.pathname === '/api/me' && req.method === 'GET') {
    const user = await getSessionUser(req);
    if (!user) { sendJson(res, 200, { loggedIn: false }); return; }
    sendJson(res, 200, {
      loggedIn: true,
      email: user.email,
      resultType: user.resultType || null,
      subscription: user.subscription || { active: false },
      reviews: user.reviews || [],
      createdAt: user.createdAt || null,
      pushSubscribed: !!user.pushSubscription,
      freeMode: FREE_FOR_ALL,
    });
    return;
  }

  // ---- 퀴즈 결과 유형을 계정에 저장 ----
  if (url.pathname === '/api/save-result' && req.method === 'POST') {
    const user = await getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: '로그인이 필요해요.' }); return; }
    const body = await readJsonBody(req).catch(() => null);
    if (!body || !body.code) { sendJson(res, 400, { error: 'code가 필요해요.' }); return; }
    user.resultType = body.code;
    await setUser(user.email, user);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- 독후감 추가 ----
  if (url.pathname === '/api/reviews' && req.method === 'POST') {
    const user = await getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: '로그인이 필요해요.' }); return; }
    const body = await readJsonBody(req).catch(() => null);
    if (!body || !body.bookTitle || !body.content) { sendJson(res, 400, { error: '책 제목과 내용을 입력해주세요.' }); return; }
    if (!Array.isArray(user.reviews)) user.reviews = [];
    const review = {
      id: makeToken().slice(0, 12),
      bookTitle: String(body.bookTitle).slice(0, 200),
      content: String(body.content).slice(0, 4000),
      createdAt: new Date().toISOString(),
    };
    user.reviews.unshift(review);
    await setUser(user.email, user);
    sendJson(res, 200, { ok: true, reviews: user.reviews });
    return;
  }

  // ---- 독후감 삭제 ----
  if (url.pathname === '/api/reviews' && req.method === 'DELETE') {
    const user = await getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: '로그인이 필요해요.' }); return; }
    const body = await readJsonBody(req).catch(() => null);
    if (!body || !body.id) { sendJson(res, 400, { error: 'id가 필요해요.' }); return; }
    if (Array.isArray(user.reviews)) {
      user.reviews = user.reviews.filter((r) => r.id !== body.id);
      await setUser(user.email, user);
    }
    sendJson(res, 200, { ok: true, reviews: user.reviews || [] });
    return;
  }

  // ---- AI 상담 채팅 ----
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const user = await getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: 'AI 상담은 회원만 이용할 수 있어요. 로그인해주세요.' }); return; }
    if (!FREE_FOR_ALL && (!user.subscription || !user.subscription.active)) { sendJson(res, 402, { error: '구독 후 이용할 수 있는 기능이에요.' }); return; }
    const body = await readJsonBody(req).catch(() => null);
    if (!body || !body.message) { sendJson(res, 400, { error: '메시지가 없어요.' }); return; }

    const tc = body.typeContext || {};
    const systemPrompt = [
      '너는 "책유형테스트" 서비스 안의 다정하고 통찰력 있는 북 컨시어지 AI야.',
      '사용자의 책 취향 유형을 참고해서 자연스럽게 대화해줘.',
      '바로 책부터 추천하지 마. 먼저 사용자의 지금 기분, 상황, 고민을 몇 마디 주고받으며 파악해. 정보가 충분히 모였다 싶으면 "이런 책 추천해줘도 될까?"처럼 한 번 물어보고 나서 추천해.',
      '책을 추천할 땐 왜 그 책이 이 사람한테 맞는지 이유를 짧게 같이 설명해줘.',
      '중요: 실제로 존재하는 책만 추천해. 제목이 확실하지 않으면 지어내지 말고, 그냥 어떤 종류/분위기의 책을 찾아보라고 안내만 해줘.',
      '단, 책 제목이 확실하면 그 내용이나 추천 이유를 물었을 때 "정확히는 몰라서..." 같은 말로 얼버무리지 말고, 아는 선에서 자신 있게 설명해. 책의 대략적인 주제·분위기를 말해주고 그게 사용자 상황에 어떻게 도움될지 자연스럽게 연결해줘.',
      tc.name ? `사용자의 책 유형: ${tc.name}` : '',
      tc.longDesc ? `유형 설명: ${tc.longDesc}` : '',
      (tc.character && tc.character.name) ? `사용자와 닮은 캐릭터: ${tc.character.name} (『${tc.character.book}』)` : '',
      (tc.books && tc.books.length) ? `이미 추천받은 책 목록: ${tc.books.join(', ')}` : '',
      '답변 길이는 상황에 맞게 조절해. 그냥 대화는 1~2문장으로 짧게, 책을 추천하고 이유를 설명할 땐 필요한 만큼 길어도 돼. 다만 장황하게 늘어지지는 마.',
      '확실한 책을 추천할 때만 제목을 [[책:정확한 제목|저자]] 형식으로 감싸줘 (예: [[책:데미안|헤르만 헤세]], 저자 모르면 [[책:제목]]만). 이 마커는 화면엔 안 보이고 자동으로 구매 링크로 바뀌니까 문장 안에 자연스럽게 녹여 써도 돼. 확신 없는 책엔 마커 쓰지 마.',
    ].filter(Boolean).join('\n');

    const history = Array.isArray(body.history) ? body.history : [];
    const messages = history.concat([{ role: 'user', content: String(body.message).slice(0, 2000) }]);

    try {
      const reply = await callClaude(systemPrompt, messages);
      sendJson(res, 200, { reply });
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) });
    }
    return;
  }

  // ---- AI가 추천한 책의 구매(검색)링크 조회 ----
  if (url.pathname === '/api/book-link' && req.method === 'GET') {
    const title = url.searchParams.get('title') || '';
    if (!title) { sendJson(res, 400, { error: 'title이 필요해요.' }); return; }
    sendJson(res, 200, { link: buildSearchTTBLink(title) });
    return;
  }

  // ---- 구독 안내 정보 ----
  if (url.pathname === '/api/payment-info' && req.method === 'GET') {
    const mode = (PAYAPP_USERID && PAYAPP_FEEDBACK_URL) ? 'payapp'
      : (BANK_NAME && BANK_ACCOUNT_NUMBER) ? 'bank'
      : (PAYMENT_LINK_URL) ? 'link' : null;
    sendJson(res, 200, {
      mode,
      paymentLinkUrl: PAYMENT_LINK_URL || null,
      priceLabel: PAYMENT_PRICE_LABEL,
      bankTransfer: (BANK_NAME && BANK_ACCOUNT_NUMBER) ? {
        bankName: BANK_NAME,
        accountNumber: BANK_ACCOUNT_NUMBER,
        accountHolder: BANK_ACCOUNT_HOLDER,
        amount: PAYMENT_AMOUNT,
      } : null,
    });
    return;
  }

  // ---- 결제 요청 시작 (로그인 필요). 페이앱 설정돼있으면 페이앱, 아니면 계좌이체 매칭코드 방식으로 폴백 ----
  if (url.pathname === '/api/request-payment' && req.method === 'POST') {
    const user = await getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: '로그인이 필요해요.' }); return; }
    const body = await readJsonBody(req).catch(() => ({}));

    if (PAYAPP_USERID && PAYAPP_FEEDBACK_URL) {
      const phoneDigits = String((body && body.phone) || '').replace(/[^0-9]/g, '') || '01000000000';
      try {
        const result = await callPayApp({
          cmd: 'payrequest',
          userid: PAYAPP_USERID,
          goodname: 'AI 상담 구독',
          price: String(PAYMENT_AMOUNT),
          recvphone: phoneDigits,
          smsuse: 'n',
          feedbackurl: PAYAPP_FEEDBACK_URL,
          var1: user.email,
          checkretry: 'y',
        });
        if (result.state !== '1') { sendJson(res, 502, { error: result.errorMessage || '페이앱 결제 요청에 실패했어요.' }); return; }
        const payments = loadPayments();
        payments.pending.push({
          mulNo: result.mul_no,
          email: user.email,
          amount: PAYMENT_AMOUNT,
          createdAt: new Date().toISOString(),
          status: 'pending',
          provider: 'payapp',
        });
        savePayments(payments);
        sendJson(res, 200, { mode: 'payapp', payUrl: result.payurl, mulNo: result.mul_no });
      } catch (e) {
        sendJson(res, 500, { error: '페이앱 연결 오류: ' + String((e && e.message) || e) });
      }
      return;
    }

    if (!BANK_NAME || !BANK_ACCOUNT_NUMBER) { sendJson(res, 503, { error: '결제 기능이 아직 준비되지 않았어요.' }); return; }
    const payments = loadPayments();
    const matchCode = makeMatchCode();
    payments.pending.push({
      matchCode,
      email: user.email,
      amount: PAYMENT_AMOUNT,
      createdAt: new Date().toISOString(),
      status: 'pending',
      provider: 'bank-sms',
    });
    savePayments(payments);
    sendJson(res, 200, {
      mode: 'bank',
      bankName: BANK_NAME,
      accountNumber: BANK_ACCOUNT_NUMBER,
      accountHolder: BANK_ACCOUNT_HOLDER,
      amount: PAYMENT_AMOUNT,
      matchCode,
    });
    return;
  }

  // ---- 페이앱 결제완료 웹훅 (form-urlencoded로 옴, JSON 아님) ----
  if (url.pathname === '/api/payapp-webhook' && req.method === 'POST') {
    const raw = await readRawBody(req).catch(() => '');
    const params = new URLSearchParams(raw);
    const userid = params.get('userid');
    const linkkey = params.get('linkkey');
    const linkval = params.get('linkval');
    const price = Number(params.get('price'));
    const payState = params.get('pay_state');
    const email = params.get('var1');
    const mulNo = params.get('mul_no');

    const valid = PAYAPP_USERID && userid === PAYAPP_USERID && linkkey === PAYAPP_LINKKEY && linkval === PAYAPP_LINKVAL;
    if (valid && payState === '4' && email && price === PAYMENT_AMOUNT) {
      const payments = loadPayments();
      const rec = payments.pending.find((p) => p.mulNo === mulNo);
      if (!rec || rec.status !== 'matched') {
        await activateSubscription(email, 30);
        if (rec) { rec.status = 'matched'; rec.matchedAt = new Date().toISOString(); }
        else payments.pending.push({ mulNo, email, amount: price, status: 'matched', matchedAt: new Date().toISOString(), provider: 'payapp' });
        savePayments(payments);
      }
    }
    // 페이앱 규격: 반드시 HTTP 200 + 본문 "SUCCESS" 로 응답해야 재시도 안 함
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('SUCCESS');
    return;
  }

  // ---- 입금 문자 웹훅(폴백): 폰의 문자포워딩 앱이 호출. 금액+매칭코드 대조해서 자동 구독활성화 ----
  if (url.pathname === '/api/deposit-webhook' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    if (!DEPOSIT_WEBHOOK_KEY || !body || body.key !== DEPOSIT_WEBHOOK_KEY) { sendJson(res, 401, { error: 'key가 맞지 않아요.' }); return; }
    const text = String(body.text || '');
    if (!text) { sendJson(res, 400, { error: 'text가 필요해요.' }); return; }

    const payments = loadPayments();
    const amountMatch = text.match(/([\d,]{3,})\s*원/);
    const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null;
    const upperText = text.toUpperCase();

    const idx = payments.pending.findIndex((p) =>
      p.status === 'pending' && upperText.includes(p.matchCode) && amount === p.amount
    );

    if (idx > -1) {
      const p = payments.pending[idx];
      const sub = await activateSubscription(p.email, 30);
      p.status = 'matched';
      p.matchedAt = new Date().toISOString();
      savePayments(payments);
      sendJson(res, 200, { ok: true, matched: true, email: p.email, subscription: sub });
      return;
    }

    // 못 찾으면 나중에 관리자가 수동으로 처리할 수 있게 큐에 저장
    payments.unmatched.push({ text, amount, receivedAt: new Date().toISOString() });
    savePayments(payments);
    sendJson(res, 200, { ok: true, matched: false });
    return;
  }

  // ---- 관리자: 결제 확인 후 수동으로 구독 활성화 (자동결제 붙기 전 임시) ----
  if (url.pathname === '/api/admin/activate-subscription' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    if (!ADMIN_KEY || !body || body.adminKey !== ADMIN_KEY) { sendJson(res, 401, { error: '관리자 키가 맞지 않아요.' }); return; }
    const email = String(body.email || '').trim().toLowerCase();
    const days = Number(body.days) || 30;
    const sub = await activateSubscription(email, days);
    if (!sub) { sendJson(res, 404, { error: '해당 이메일 계정을 찾을 수 없어요.' }); return; }
    sendJson(res, 200, { ok: true, subscription: sub });
    return;
  }

  // ---- 관리자: 대기중/매칭실패 입금 목록 조회 ----
  if (url.pathname === '/api/admin/pending-payments' && req.method === 'GET') {
    if (!ADMIN_KEY || url.searchParams.get('adminKey') !== ADMIN_KEY) { sendJson(res, 401, { error: '관리자 키가 맞지 않아요.' }); return; }
    const payments = loadPayments();
    sendJson(res, 200, {
      pending: payments.pending.filter((p) => p.status === 'pending').slice(-50).reverse(),
      unmatched: payments.unmatched.slice(-50).reverse(),
    });
    return;
  }

  // ---- 관리자 페이지 (결제 확인 후 구독 켜주는 간단한 폼) ----
  if (url.pathname === '/admin' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="ko"><head><meta charset="UTF-8"><title>구독 관리</title>
      <style>body{font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 20px;}
      input{display:block;width:100%;padding:10px;margin-bottom:10px;box-sizing:border-box;}
      button{padding:10px 20px;}#msg{margin-top:14px;font-size:14px;}</style></head>
      <body>
      <h2>구독 수동 활성화</h2>
      <p style="color:#666;font-size:13px;">결제 확인 후 이메일과 관리자 키를 입력해서 구독을 열어줍니다.</p>
      <input id="adminKey" type="password" placeholder="관리자 키">
      <input id="email" type="email" placeholder="회원 이메일">
      <input id="days" type="number" value="30" placeholder="기간(일)">
      <button id="go">구독 활성화</button>
      <div id="msg"></div>

      <hr style="margin:32px 0;">
      <h2>대기중 입금 / 매칭 실패 목록</h2>
      <p style="color:#666;font-size:13px;">계좌이체 결제 요청했는데 자동매칭 안 된 건들. 새로고침 버튼 눌러서 확인.</p>
      <button id="refreshPending">새로고침</button>
      <div id="pendingList" style="margin-top:14px;font-size:13px;"></div>

      <hr style="margin:32px 0;">
      <h2>월간 큐레이션 푸시 발송</h2>
      <p style="color:#666;font-size:13px;">구독자 전원에게 알림을 보냅니다. 제목/내용 비워두면 기본 문구로 나가요.</p>
      <input id="pushTitle" placeholder="제목 (선택)">
      <input id="pushBody" placeholder="내용 (선택)">
      <button id="pushGo">지금 발송</button>
      <div id="pushMsg"></div>

      <script>
        document.getElementById('go').onclick = async () => {
          const adminKey = document.getElementById('adminKey').value;
          const email = document.getElementById('email').value;
          const days = document.getElementById('days').value;
          const res = await fetch('/api/admin/activate-subscription', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ adminKey, email, days }),
          });
          const data = await res.json();
          document.getElementById('msg').textContent = res.ok
            ? '완료: ' + email + ' 구독 활성화됨 (만료 ' + data.subscription.expiresAt + ')'
            : '오류: ' + data.error;
        };
        document.getElementById('refreshPending').onclick = async () => {
          const adminKey = document.getElementById('adminKey').value;
          const res = await fetch('/api/admin/pending-payments?adminKey=' + encodeURIComponent(adminKey));
          const data = await res.json();
          const el = document.getElementById('pendingList');
          if (!res.ok) { el.textContent = '오류: ' + data.error; return; }
          let html = '<b>대기중(' + data.pending.length + ')</b><ul>';
          data.pending.forEach(p => {
            html += '<li>' + p.email + ' · ' + p.amount + '원 · 코드 ' + p.matchCode + ' · ' + p.createdAt + '</li>';
          });
          html += '</ul><b>매칭 실패 문자(' + data.unmatched.length + ')</b><ul>';
          data.unmatched.forEach(u => {
            html += '<li>' + u.receivedAt + ' · 금액추정 ' + (u.amount || '?') + '원 · "' + u.text + '"</li>';
          });
          html += '</ul>';
          el.innerHTML = html;
        };
        document.getElementById('pushGo').onclick = async () => {
          const adminKey = document.getElementById('adminKey').value;
          const title = document.getElementById('pushTitle').value;
          const body = document.getElementById('pushBody').value;
          const res = await fetch('/api/admin/send-monthly-push', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ adminKey, title, body }),
          });
          const data = await res.json();
          document.getElementById('pushMsg').textContent = res.ok
            ? '발송 완료: 성공 ' + data.sent + ', 실패 ' + data.failed + ', 만료구독 제거 ' + data.removed
            : '오류: ' + data.error;
        };
      </script></body></html>`);
    return;
  }

  // ---- 푸시 알림: VAPID 공개키 조회 ----
  if (url.pathname === '/api/vapid-public-key' && req.method === 'GET') {
    sendJson(res, 200, { key: (webpush && VAPID_PUBLIC_KEY) ? VAPID_PUBLIC_KEY : null });
    return;
  }

  // ---- 푸시 알림 구독 등록 ----
  if (url.pathname === '/api/push-subscribe' && req.method === 'POST') {
    const user = await getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: '로그인이 필요해요.' }); return; }
    const body = await readJsonBody(req).catch(() => null);
    if (!body || !body.subscription) { sendJson(res, 400, { error: 'subscription이 필요해요.' }); return; }
    user.pushSubscription = body.subscription;
    await setUser(user.email, user);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- 푸시 알림 구독 해제 ----
  if (url.pathname === '/api/push-unsubscribe' && req.method === 'POST') {
    const user = await getSessionUser(req);
    if (!user) { sendJson(res, 401, { error: '로그인이 필요해요.' }); return; }
    user.pushSubscription = null;
    await setUser(user.email, user);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- 관리자: 월간 큐레이션 푸시 발송 ----
  if (url.pathname === '/api/admin/send-monthly-push' && req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null);
    if (!ADMIN_KEY || !body || body.adminKey !== ADMIN_KEY) { sendJson(res, 401, { error: '관리자 키가 맞지 않아요.' }); return; }
    if (!webpush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) { sendJson(res, 503, { error: '푸시 기능이 아직 설정되지 않았어요 (web-push 미설치 또는 VAPID 키 없음).' }); return; }
    const title = body.title || '이번 달 책 큐레이션이 도착했어요 📚';
    const messageBody = body.body || '앱을 열어서 이번 달 추천 도서를 확인해보세요.';
    const users = await listAllUsersMap();
    let sent = 0, failed = 0, removed = 0;
    const jobs = Object.keys(users).map(async (email) => {
      const u = users[email];
      if (!u.pushSubscription) return;
      try {
        await webpush.sendNotification(u.pushSubscription, JSON.stringify({ title, body: messageBody, url: '/' }));
        sent++;
      } catch (e) {
        failed++;
        if (e && (e.statusCode === 410 || e.statusCode === 404)) { u.pushSubscription = null; removed++; await setUser(email, u); }
      }
    });
    await Promise.all(jobs);
    sendJson(res, 200, { ok: true, sent, failed, removed });
    return;
  }

  // 정적 파일 서빙 (기본은 프로토타입 HTML)
  let filePath = url.pathname === '/' ? HTML_FILE : '.' + decodeURIComponent(url.pathname);
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('파일을 찾을 수 없습니다: ' + filePath);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Firestore/외부 API 호출이 늘면서 예기치 못한 network reject가 전체 서버를 죽이지 않게 방어
process.on('unhandledRejection', (e) => { console.error('처리 안 된 Promise 오류:', e); });

server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(ALADIN_TTB_KEY === FALLBACK_KEY
    ? '[주의] ALADIN_TTB_KEY 환경변수가 없어서 코드 내 기본값을 쓰고 있음. 배포 전 환경변수로 교체할 것.'
    : '환경변수로 지정된 ALADIN_TTB_KEY 사용 중');
});

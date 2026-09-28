// e2e용 서버 두 개: 가짜 LLM(OpenAI 호환, :8765)과 테스트 페이지(:8766)
import http from 'node:http';
import { readFileSync } from 'node:fs';

export const calls = [];

function mockLLM(req, res) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const { messages } = JSON.parse(body);
    const system = messages[0].content, user = messages.at(-1).content;
    calls.push({ system, user });
    let content;
    if (system.includes('추상 구조로')) content = '비용을 내고 시도하면 결과가 확률에 따라 달라지는 구조';
    else if (user.includes('연결 성공')) content = '연결 성공';
    else {
      const [, id, label] = user.match(/\[1\] id=(\S+) \| (.+)/);
      const tag = user.match(/맞은 추상 태그: .+? \(id=(\S+)\)/);
      content = '```json\n' + JSON.stringify({ meaning: '테스트 뜻 풀이예요.', analogy: `메이플로 치면 ${label}과 같은 구조예요.`, nodeId: id, tagId: tag?.[1] ?? null, mapping: `원문 ↔ ${label}` }) + '\n```';
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
}

function staticPage(_req, res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(new URL('./page.html', import.meta.url)));
}

export async function startServers() {
  const a = http.createServer(mockLLM).listen(8765, '127.0.0.1');
  const b = http.createServer(staticPage).listen(8766, '127.0.0.1');
  await Promise.all([a, b].map(s => new Promise(r => s.once('listening', r))));
  return () => Promise.all([a, b].map(s => new Promise(r => s.close(r))));
}

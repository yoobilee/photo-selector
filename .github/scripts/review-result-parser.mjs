// 리뷰 원문을 처음부터 끝까지 문장 단위로 해석한다. 관찰한 문형만 받으며 남는 산문은 판단 불가(unknown)로 둔다.
// 코드 지적(findings)과 리뷰어가 보고한 로컬 검사(reviewerChecks)는 서로 섞지 않는다.
// 검사 문장은 리뷰어의 주장일 뿐 실행 증명이 아니다. 실패를 통과로 바꾸거나 원인을 환경 문제로 확정하지 않는다.
// v4: Issue #41에서 관찰한 "identified" 선언과 검사 어휘 `verification`을 추가했다. 같은 원문도 v3와 해석이 다를 수 있으므로
// 저장된 결과는 다시 해석해 바꾸지 않고 해석 차이를 따로 표시한다(review-attention.mjs interpretStoredResult).
export const parserVersion = 4;

const levels = ['critical', 'high', 'medium', 'low'];
const capitalized = word => `[${word[0].toUpperCase()}${word[0]}]${word.slice(1)}`;
const anyOf = words => `(?:${words.join('|')})`;

// 관찰한 "지적 없음" 선언. 리뷰 원문의 첫 문장이어야 한다.
// "identified" 문형은 PR #30("defects … in the changes."), PR #37("regressions … in the changes against the specified base."),
// PR #40("regressions … identified.")에서 관찰했다. 검토 범위를 일부로 좁히는 임의 수식어("in the documentation … changes")는 받지 않는다.
const declarations = [
  /No actionable defects were found(?: in the changes against the specified base)?\./y,
  /No actionable (?:defects|regressions) were identified(?: in the changes(?: against the specified base)?)?\./y,
  /No findings\./y,
  /No issues found\./y,
  /기준 커밋 대비 변경에서 수정이 필요한 결함을 발견하지 못했습니다\./y,
];

// 검사 이름은 정해진 어휘와 코드 식별자만 허용한다. 임의 산문이 검사 이름으로 해석되지 않게 한다.
const identifier = String.raw`(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[a-z][a-z0-9]*(?:[:./-][a-z0-9]+)+)`;
const command = String.raw`(?:\x60(?:npm (?:run )?[a-z][a-z0-9:-]*|git diff --check|${identifier})\x60)`;
const englishNumber = `(?:\\d+|${anyOf(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].map(capitalized))})`;
const englishQualifier = anyOf([...['targeted', 'focused', 'full', 'related', 'unit', 'platform-specific', 'merge-tool', 'review-gate', 'gate', 'verification', 'sharpness', 'blur', 'component', 'integration'].map(capitalized), 'E2E', 'end-to-end', 'Playwright', 'Vitest']);
const englishNoun = '(?:test suites?|tests?|checks?|suites?)';
const englishNamed = `(?:${capitalized('lint')}|ESLint|TypeScript(?: checks?)?|${capitalized('typecheck')}|${capitalized('type')} ?checks?|${capitalized('build')}(?: checks?)?|E2E(?: checks| tests)?)`;
const englishItem = `(?:(?:${capitalized('all')} |${capitalized('the')} )?(?:${englishNumber} )?(?:${englishQualifier} )*${englishNoun}|${englishNamed}|(?:${identifier}|${command})(?: ${englishNoun})?)`;
// 원인은 리뷰어가 샌드박스 권한 제한을 명시한 경우만 "환경 제약 주장"으로 기록한다.
const englishCause = '(?:(?:a|the) )?sandbox (?:EPERM|(?:file-?system |write |temp(?:orary)?[- ]directory )?permission (?:restriction|limit)s?)';
const englishVerb = `(passed|failed(?: (?:due to|because of) (${englishCause}))?|(?:were|was) not (?:run|executed)|(?:were|was) skipped)`;
const englishClause = new RegExp(`(${englishItem}(?:, ${englishItem})*(?:,? and ${englishItem})?) ${englishVerb}`, 'y');
// PR #25에서 관찰한 문형. 전체 실행 중 특정 테스트가 샌드박스 오류로 실패했다는 뜻으로만 해석한다.
const englishEncountered = new RegExp(`${capitalized('the')} full unit run encountered (${englishCause}) in (${identifier}|${command})`, 'y');
const englishJoin = /, and |, | and /y;
const englishSeparator = /; |, and |, but | but /y;

const koreanQualifier = anyOf(['전체', '관련', '대상', '집중', '핵심', '주요']);
const koreanBase = anyOf(['Lint', 'ESLint', 'TypeScript', 'Build', 'E2E', identifier, command, '단위', '선명도', '흐림', '병합 도구', '리뷰 게이트', '게이트', '타입', '린트', '빌드', '컴포넌트', '회귀', '플랫폼별']);
const koreanItem = `(?:${koreanQualifier} )?(?:${koreanBase}(?: (?:검사|테스트))?|테스트|검사)(?: \\d+개)?`;
const koreanCause = '(?:(?:리뷰 |검토 )?(?:환경|샌드박스)의 (?:[가-힣]+ ){0,4}(?:쓰기 |접근 )?권한 제한|샌드박스 EPERM)';
const koreanClause = new RegExp(`(${koreanItem}(?:(?:·|, | 및 |와 |과 )${koreanItem})*)(?:는|은) (?:(\\d+)개 )?(?:(${koreanCause})(?:으로|로) )?(통과했|실패했|실행하지 않았|실행되지 않았|건너뛰었|생략했)(습니다\\.|으나 |으며, |으며 |고 |지만 )`, 'y');
const koreanJoin = /·|, | 및 |와 |과 /y;

const englishStatus = verb => verb === 'passed' ? 'passed' : verb.startsWith('failed') ? 'failed' : verb.endsWith('skipped') ? 'skipped' : 'not-run';
const koreanStatus = { 통과했: 'passed', 실패했: 'failed', '실행하지 않았': 'not-run', '실행되지 않았': 'not-run', 건너뛰었: 'skipped', 생략했: 'skipped' };

function stickyAt(pattern, text, position) {
  pattern.lastIndex = position;
  return pattern.exec(text);
}

// 목록 문자열을 항목 문법과 연결어로 끝까지 나눈다. 남는 문자가 있으면 해석하지 않는다.
function listItems(list, itemPattern, joinPattern) {
  const item = new RegExp(itemPattern, 'y');
  const items = [];
  let position = 0;
  while (position < list.length) {
    if (items.length) {
      const join = stickyAt(joinPattern, list, position);
      if (!join) return null;
      position += join[0].length;
    }
    const match = stickyAt(item, list, position);
    if (!match || !match[0]) return null;
    items.push(match[0]);
    position += match[0].length;
  }
  return items.length ? items : null;
}

const check = (name, status, count, cause) => ({
  name, status, count, cause: cause ? { kind: 'environment-claimed', text: cause } : null,
});

// 문장을 끝까지 해석하면 { end, checks }, 아니면 해석이 멈춘 위치 { failedAt }을 돌려준다. 일부만 해석한 검사는 버린다.
function englishSentence(text, start) {
  const checks = [];
  let position = start;
  for (;;) {
    const encountered = stickyAt(englishEncountered, text, position);
    const clause = encountered ? null : stickyAt(englishClause, text, position);
    if (encountered) {
      checks.push(check(encountered[2], 'failed', null, encountered[1]));
      position += encountered[0].length;
    } else if (clause) {
      const items = listItems(clause[1], englishItem, englishJoin);
      if (!items) return { failedAt: position };
      for (const name of items) checks.push(check(name, englishStatus(clause[2]), null, clause[3] ?? null));
      position += clause[0].length;
    } else return { failedAt: position };
    if (text[position] === '.') return { end: position + 1, checks };
    const separator = stickyAt(englishSeparator, text, position);
    if (!separator) return { failedAt: position };
    position += separator[0].length;
  }
}

function koreanSentence(text, start) {
  const checks = [];
  let position = start;
  for (;;) {
    const clause = stickyAt(koreanClause, text, position);
    if (!clause) return { failedAt: position };
    const [, list, count, cause, verb, ending] = clause;
    const items = listItems(list, koreanItem, koreanJoin);
    const status = koreanStatus[verb];
    // 개수가 어느 항목의 것인지 모호하거나 실패가 아닌 결과에 원인이 붙으면 해석하지 않는다.
    if (!items || (count && items.length !== 1) || (cause && status !== 'failed')) return { failedAt: position };
    for (const name of items) checks.push(check(name, status, count ? Number(count) : null, cause ?? null));
    position += clause[0].length;
    if (ending === '습니다.') return { end: position, checks };
  }
}

// 영어 문법을 먼저, 아니면 한국어 문법을 적용한다. 둘 다 실패하면 더 멀리 해석한 위치를 진단에 쓴다.
function sentenceAt(text, start) {
  const english = englishSentence(text, start);
  if (english.checks) return english;
  const korean = koreanSentence(text, start);
  if (korean.checks) return korean;
  return { failedAt: Math.max(english.failedAt, korean.failedAt) };
}

// 판단 불가(unknown) 사유. 사유 하나가 unknown 1건이다. 원문의 어느 부분이 문법 밖인지 관리자에게 알리는 진단용이며,
// 게시 결과·서버 검증에는 기존처럼 findings와 reviewerChecks만 쓴다.
export const unknownReasonText = {
  'not-text': '리뷰 원문이 문자열이 아님',
  'declaration-unrecognized': '첫 문장이 관찰한 "지적 없음" 선언 문형이 아님(뒤 문장은 해석하지 않음)',
  'sentence-unrecognized': '선언 뒤 문장을 검사 결과 문법(검사 이름·연결어·통과/실패/미실행/건너뜀)으로 해석하지 못한 위치(그 문장과 뒤 문장의 검사는 기록하지 않음)',
  'unexplained-check-failure': '원인을 밝히지 않은 검사 실패(코드 결함 가능성을 배제할 수 없음)',
  'incomplete-review-phrase': '사용량 한도·리뷰 생략·리뷰 미완료를 뜻하는 표현',
  'malformed-badge': '형식이 맞지 않는 지적 배지',
};

// 진단 표시용 발췌. 다음 마침표·쌍반점까지만 보여 준다.
function excerptAt(body, position) {
  const rest = body.slice(position);
  const end = rest.search(/[.;](?:\s|$)/);
  const sentence = (end >= 0 ? rest.slice(0, end + 1) : rest).replace(/\s+/g, ' ').trim();
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
}

function analyze(text) {
  const findings = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  const reviewerChecks = [];
  const reasons = [];
  if (typeof text !== 'string') return { findings: { ...findings, unknown: 1 }, reviewerChecks, reasons: [{ kind: 'not-text' }] };
  for (const badge of text.matchAll(/\[P([0-3])\]/g)) findings[levels[Number(badge[1])]] += 1;
  const body = text.replace(/\r\n?/g, '\n').trim();
  const declaration = declarations.map(pattern => stickyAt(pattern, body, 0)).find(Boolean);
  if (!declaration) reasons.push({ kind: 'declaration-unrecognized', offset: 0, excerpt: excerptAt(body, 0) });
  let position = declaration?.[0].length ?? 0;
  while (declaration && position < body.length) {
    // 문장 사이에는 공백이 있어야 한다. 이어 붙은 문장이나 일부만 해석된 문장은 받지 않는다.
    const gap = stickyAt(/\s+/y, body, position);
    const sentence = gap ? sentenceAt(body, position + gap[0].length) : { failedAt: position };
    if (!sentence.checks) { reasons.push({ kind: 'sentence-unrecognized', offset: sentence.failedAt, excerpt: excerptAt(body, sentence.failedAt) }); break; }
    reviewerChecks.push(...sentence.checks);
    position = sentence.end;
  }
  // 원인을 밝히지 않은 실패는 코드 결함일 수 있다. 환경 문제로 간주하지 않고 판단 불가로 남긴다.
  const unexplained = reviewerChecks.filter(item => item.status === 'failed' && !item.cause);
  if (unexplained.length) reasons.push({ kind: 'unexplained-check-failure', checks: unexplained.map(item => item.name) });
  const incomplete = /rate limit|usage limit|quota exceeded|review (?:was )?(?:skipped|not run)|unable to (?:complete|perform) (?:the )?review/i.exec(text);
  if (incomplete) reasons.push({ kind: 'incomplete-review-phrase', excerpt: incomplete[0] });
  const malformed = /\[P[^\]]*\]/.exec(text.replace(/\[P[0-3]\]/g, ''));
  if (malformed) reasons.push({ kind: 'malformed-badge', excerpt: malformed[0].slice(0, 40) });
  findings.unknown = reasons.length;
  return { findings, reviewerChecks, reasons };
}

// 반환값의 findings는 코드 지적과 판단 불가만, reviewerChecks는 리뷰어가 보고한 로컬 검사만 담는다.
export function analyzeReviewText(text) {
  const { findings, reviewerChecks } = analyze(text);
  return { findings, reviewerChecks };
}

// unknown 사유 목록. 길이는 항상 findings.unknown과 같다.
export const explainReviewText = text => analyze(text).reasons;

export function findingsFromText(text) {
  return analyzeReviewText(text).findings;
}

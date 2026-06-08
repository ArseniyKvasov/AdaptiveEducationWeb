const summaryContainer = document.getElementById('summaryContainer');
const quizContainer = document.getElementById('quizContainer');
const practiceContainer = document.getElementById('practiceContainer');
const practiceTabBtn = document.getElementById('practiceTabBtn');
const tabBtns = document.querySelectorAll('.tab-btn');
const panels = {
  summary: document.getElementById('panelSummary'),
  quiz: document.getElementById('panelQuiz'),
  practice: document.getElementById('panelPractice')
};

let generationId = '';
let quizData = [];
let summaryData = [];
let practiceData = normalizePracticeState({});
let practiceTabOpened = false;
let activeSummarySubtopic = '';
const quizState = {
  index: 0,
  answers: {},
  checkStatus: 'idle',
  checkResult: null,
  reviewMode: false
};
const practiceQuizState = {
  index: 0,
  answers: {},
  finished: false,
  submitting: false
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

const MATH_SEGMENT_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]+?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g;
const LATEX_CONTROL_REPAIR_MAP = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r'
};

function repairLatexMathSegment(segment) {
  return String(segment || '').replace(/[\b\t\n\v\f\r]/g, (char) => LATEX_CONTROL_REPAIR_MAP[char] || char);
}

function normalizeTextWithMathSegments(text) {
  const raw = String(text ?? '');
  if (!raw) return '';

  let result = '';
  let lastIndex = 0;
  const mathRegex = new RegExp(MATH_SEGMENT_RE.source, 'g');

  for (const match of raw.matchAll(mathRegex)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      result += raw.slice(lastIndex, index).replace(/\\n/g, '\n').replace(/\u2014/g, '-');
    }
    result += repairLatexMathSegment(match[0]);
    lastIndex = index + match[0].length;
  }

  if (lastIndex < raw.length) {
    result += raw.slice(lastIndex).replace(/\\n/g, '\n').replace(/\u2014/g, '-');
  }

  return result;
}

function protectMathSegments(text) {
  const mathParts = [];
  const protectedText = (text || '').replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, (match) => {
    const token = `@@MATH_${mathParts.length}@@`;
    mathParts.push(match);
    return token;
  });
  return { text: protectedText, mathParts };
}

function restoreMathSegments(text, mathParts) {
  return text.replace(/@@MATH_(\d+)@@/g, (_match, idx) => mathParts[Number(idx)] || '');
}

function normalizeTextBreaks(text) {
  return normalizeTextWithMathSegments(text);
}

function removePunctuationAfterBlockMath(text) {
  return (text || '').replace(/\$\$[\s\S]*?\$\$[\s]*[.,;:!?]+/g, (match) => {
    const mathEnd = match.lastIndexOf('$$');
    return match.slice(0, mathEnd + 2);
  });
}

function prepareSummaryTextForDisplay(text) {
  const normalized = normalizeTextBreaks(removePunctuationAfterBlockMath(text));
  const lines = normalized.split(/\r?\n/);
  const trimmedBackslashes = lines.map((line) => (line.endsWith('\\') ? line.slice(0, -1) : line));
  const removedDividerLines = trimmedBackslashes.map((line) => {
    if (line.trim() === '---') return '';
    return line.replace(/^\s{0,3}#{1,6}(?=\s|$)\s?/, '');
  });
  return removedDividerLines.join('\n');
}

function normalizeQuizText(text) {
  return normalizeTextWithMathSegments(text);
}

function normalizePracticeState(raw) {
  const state = {
    status: 'idle',
    stage: '',
    weak_subtopics: [],
    current_weak_subtopics: [],
    pending_weak_subtopics: [],
    mastery: {},
    mastery_order: [],
    practice_round: 0,
    round_submitted: false,
    practice_completed: false,
    request: {},
    summary: [],
    quiz: [],
    error_message: '',
    stale_reason: '',
    updated_at: ''
  };
  if (!raw || typeof raw !== 'object') return state;
  state.status = String(raw.status || state.status);
  state.stage = String(raw.stage || state.stage);
  state.error_message = String(raw.error_message || state.error_message);
  state.stale_reason = String(raw.stale_reason || state.stale_reason);
  state.updated_at = String(raw.updated_at || state.updated_at);
  state.practice_round = Number.isFinite(Number(raw.practice_round)) ? Number(raw.practice_round) : state.practice_round;
  state.round_submitted = Boolean(raw.round_submitted);
  state.practice_completed = Boolean(raw.practice_completed);
  if (Array.isArray(raw.weak_subtopics)) {
    state.weak_subtopics = raw.weak_subtopics.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (Array.isArray(raw.current_weak_subtopics)) {
    state.current_weak_subtopics = raw.current_weak_subtopics.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (Array.isArray(raw.pending_weak_subtopics)) {
    state.pending_weak_subtopics = raw.pending_weak_subtopics.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (raw.mastery && typeof raw.mastery === 'object') {
    state.mastery = raw.mastery;
  }
  if (Array.isArray(raw.mastery_order)) {
    state.mastery_order = raw.mastery_order.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (raw.request && typeof raw.request === 'object') state.request = raw.request;
  if (Array.isArray(raw.summary)) state.summary = raw.summary;
  if (Array.isArray(raw.quiz)) state.quiz = raw.quiz;
  return state;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = 'Ошибка запроса.';
    try {
      const body = await res.json();
      detail = body.detail || body.error || detail;
    } catch (_e) {
      // ignore
    }
    const error = new Error(detail);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function practiceHasVisibleState(practice = practiceData) {
  return Boolean(
    practice
    && (
      practice.status !== 'idle'
      || practice.round_submitted
      || practice.practice_completed
      || (Array.isArray(practice.summary) && practice.summary.length)
      || (Array.isArray(practice.quiz) && practice.quiz.length)
      || (Array.isArray(practice.pending_weak_subtopics) && practice.pending_weak_subtopics.length)
    )
  );
}

function ensurePracticeTabVisible() {
  if (!practiceTabBtn) return;
  practiceTabBtn.hidden = false;
  practiceTabBtn.disabled = false;
  practiceTabBtn.style.opacity = '1';
}

function openPracticeTab() {
  practiceTabOpened = true;
  ensurePracticeTabVisible();
}

function setPracticeState(nextState) {
  practiceData = normalizePracticeState({ ...practiceData, ...nextState });
}

function getPracticeMasteryFromCheck() {
  const mastery = quizState.checkResult && Array.isArray(quizState.checkResult.mastery)
    ? quizState.checkResult.mastery
    : [];
  return mastery
    .map((item) => ({
      subtopic: String(item.subtopic || '').trim(),
      percent: Number(item.percent || 0),
      correct: Number(item.correct || 0),
      total: Number(item.total || 0)
    }))
    .filter((item) => item.subtopic);
}

function buildPracticeCompletionPayload() {
  const quiz = Array.isArray(practiceData.quiz) ? practiceData.quiz : [];
  const answers = quiz.map((q, idx) => {
    const qid = String(q.question_id || idx + 1);
    const qtype = q.question_type === 'open_ended' || q.question_type === 'open_question' ? 'open_question' : 'multiple_choice';
    const answerState = practiceQuizState.answers[qid] || {};
    if (qtype === 'multiple_choice') {
      const selected = answerState.answer;
      const correctAnswer = Number(q.correct_answer);
      return {
        question_id: qid,
        question_type: 'multiple_choice',
        subtopic: q.subtopic || `Подтема ${idx + 1}`,
        is_correct: Number.isInteger(selected) && selected === correctAnswer
      };
    }
    return {
      question_id: qid,
      question_type: 'open_question',
      subtopic: q.subtopic || `Подтема ${idx + 1}`,
      question_text: q.question_text || '',
      correct_answer: q.correct_answer || '',
      student_answer: typeof answerState.answer === 'string' ? answerState.answer : String(answerState.answer || '')
    };
  });
  return { answers };
}

function getPracticeActionState() {
  const pending = Array.isArray(practiceData.pending_weak_subtopics) ? practiceData.pending_weak_subtopics : [];
  const practiceCompleted = Boolean(practiceData.practice_completed);
  if (practiceCompleted || (!pending.length && practiceData.round_submitted)) {
    return {
      label: 'Практика пройдена',
      disabled: true,
      kind: 'done'
    };
  }
  if (
    pending.length
    || practiceData.round_submitted
    || (practiceData.practice_round > 0 && (Array.isArray(practiceData.summary) && practiceData.summary.length || Array.isArray(practiceData.quiz) && practiceData.quiz.length))
  ) {
    return {
      label: 'Продолжить практику',
      disabled: false,
      kind: 'continue'
    };
  }
  const weakSubtopics = getPracticeWeakSubtopicsFromCheck();
  if (weakSubtopics.length) {
    return {
      label: 'Перейти к практике',
      disabled: false,
      kind: 'start'
    };
  }
  return null;
}

function getPracticeWeakSubtopicsFromCheck() {
  if (quizState.checkResult && Array.isArray(quizState.checkResult.recommendations) && quizState.checkResult.recommendations.length) {
    return quizState.checkResult.recommendations
      .map((item) => String(item.subtopic || '').trim())
      .filter(Boolean);
  }
  if (quizState.checkResult && Array.isArray(quizState.checkResult.mastery)) {
    return quizState.checkResult.mastery
      .filter((item) => Number(item.percent || 0) < 80)
      .map((item) => String(item.subtopic || '').trim())
      .filter(Boolean);
  }
  return [];
}

function buildPracticeQuestionsPayload() {
  const weakSubtopics = getPracticeWeakSubtopicsFromCheck();
  const weakSet = new Set(weakSubtopics.map((item) => item.trim().toLowerCase()));
  const questions = [];
  const mastery = getPracticeMasteryFromCheck();

  quizData.forEach((q, idx) => {
    const subtopic = String(q.subtopic || `Подтема ${idx + 1}`).trim();
    if (weakSet.size && !weakSet.has(subtopic.toLowerCase())) return;
    const qid = String(q.question_id || idx + 1);
    const answerState = quizState.answers[qid] || {};
    const open = q.question_type === 'open_ended' || q.question_type === 'open_question';
    const selectedIndex = Number(answerState.answer);
    const selectedText = !open && Array.isArray(q.options) && Number.isInteger(selectedIndex) ? String(q.options[selectedIndex] || '').trim() : '';
    const correctIndex = Number(q.correct_answer);
    const correctText = !open && Array.isArray(q.options) && Number.isInteger(correctIndex) ? String(q.options[correctIndex] || '').trim() : String(q.correct_answer || '').trim();
    const studentText = open ? String(answerState.answer || '').trim() : selectedText;

    questions.push({
      question_id: qid,
      question_type: open ? 'open_ended' : 'multiple_choice',
      subtopic,
      question_text: String(q.question_text || '').trim(),
      student_answer: studentText,
      correct_answer: correctText,
      is_correct: open ? Boolean(answerState.answered) : (Number.isInteger(selectedIndex) && selectedIndex === correctIndex),
      explanation: String(q.explanation || '').trim()
    });
  });

  if (!questions.length) {
    quizData.forEach((q, idx) => {
      const subtopic = String(q.subtopic || `Подтема ${idx + 1}`).trim();
      const qid = String(q.question_id || idx + 1);
      const answerState = quizState.answers[qid] || {};
      const open = q.question_type === 'open_ended' || q.question_type === 'open_question';
      const selectedIndex = Number(answerState.answer);
      const selectedText = !open && Array.isArray(q.options) && Number.isInteger(selectedIndex) ? String(q.options[selectedIndex] || '').trim() : '';
      const correctIndex = Number(q.correct_answer);
      const correctText = !open && Array.isArray(q.options) && Number.isInteger(correctIndex) ? String(q.options[correctIndex] || '').trim() : String(q.correct_answer || '').trim();
      const studentText = open ? String(answerState.answer || '').trim() : selectedText;

      questions.push({
        question_id: qid,
        question_type: open ? 'open_ended' : 'multiple_choice',
        subtopic,
        question_text: String(q.question_text || '').trim(),
        student_answer: studentText,
        correct_answer: correctText,
        is_correct: open ? Boolean(answerState.answered) : (Number.isInteger(selectedIndex) && selectedIndex === correctIndex),
        explanation: String(q.explanation || '').trim()
      });
    });
  }

  return {
    weak_subtopics: weakSubtopics,
    mastery,
    questions
  };
}

function markdownInlineToHtml(text) {
  let html = escapeHtml(normalizeTextBreaks(text));
  const protectedMath = protectMathSegments(html);
  html = protectedMath.text;
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/\n/g, '<br>');
  return restoreMathSegments(html, protectedMath.mathParts);
}

function stripListMarker(text) {
  return String(text || '').replace(/^\s*[\*\-]\s+/, '').trim();
}

function markdownInlineToHtmlQuiz(text) {
  let html = escapeHtml(normalizeQuizText(text));
  const protectedMath = protectMathSegments(html);
  html = protectedMath.text;
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/\n/g, '<br>');
  return restoreMathSegments(html, protectedMath.mathParts);
}

function formatMarkdownToHtml(text) {
  const source = escapeHtml(prepareSummaryTextForDisplay(text));
  const protectedMath = protectMathSegments(source);
  let html = protectedMath.text;

  // Protect code blocks before paragraph splitting
  const codeParts = [];
  html = html.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const token = `@@CODE_${codeParts.length}@@`;
    codeParts.push({ lang: lang || 'plaintext', code });
    return token;
  });

  const renderInline = (value) => {
    let inline = String(value || '');
    const inlineCodeParts = [];
    inline = inline.replace(/`([^`\n]+)`/g, (_match, code) => {
      const token = `@@INLINE_CODE_${inlineCodeParts.length}@@`;
      inlineCodeParts.push(code);
      return token;
    });
    inline = inline
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>')
      .replace(/@@INLINE_CODE_(\d+)@@/g, (_m, idx) => `<span class="inline-code">${inlineCodeParts[Number(idx)] || ''}</span>`);
    return inline;
  };

  const blocks = html.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);

  const formattedBlocks = blocks.map((block) => {
    // Restore code block tokens first
    if (block.includes('@@CODE_')) {
      return block.replace(/@@CODE_(\d+)@@/g, (_m, idx) => {
        const part = codeParts[Number(idx)];
        if (!part) return '';
        const langClass = part.lang && part.lang !== 'plaintext' ? `language-${part.lang}` : '';
        return `<pre class="code-block"><code class="${langClass}">${part.code}</code></pre>`;
      });
    }

    const lines = block.split('\n').map((line) => line.trimEnd());
    const isTableDivider = (line) => {
      const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
      return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
    };
    const isListLine = (line) => /^[\*\-\u2013\u2014] /.test(line.trim());
    const splitRow = (line) => {
      const rawCells = line.split('|').map((cell) => cell.trim());
      const cells = rawCells.filter((cell, idx, arr) => !(idx === 0 && !line.startsWith('|') && cell === '') && !(idx === arr.length - 1 && !line.endsWith('|') && cell === ''));
      while (cells.length && !cells[0]) cells.shift();
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      return cells;
    };

    const parts = [];
    let i = 0;
    while (i < lines.length) {
      const current = lines[i];
      const next = lines[i + 1] || '';

      if (!current) {
        parts.push('<p><br></p>');
        i += 1;
        continue;
      }

      if (current && current.includes('|') && isTableDivider(next)) {
        const tableLines = [current, next];
        i += 2;
        while (i < lines.length && lines[i].includes('|')) {
          tableLines.push(lines[i]);
          i += 1;
        }
        const rows = tableLines.map((line) => splitRow(line));
        const header = rows[0] || [];
        const bodyRows = rows.slice(2);
        const columnCount = Math.max(1, ...rows.map((row) => row.length));
        const colgroup = Array.from({ length: columnCount }, () => '<col style="width:clamp(100px, 18vw, 240px);">').join('');
        const headerHtml = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
        const bodyHtml = bodyRows
          .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}${Array.from({ length: Math.max(0, columnCount - row.length) }, () => '<td></td>').join('')}</tr>`)
          .join('');
        parts.push(`<div class="table-wrap"><table class="markdown-table"><colgroup>${colgroup}</colgroup><thead><tr>${headerHtml}${Array.from({ length: Math.max(0, columnCount - header.length) }, () => '<th></th>').join('')}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
        continue;
      }

      if (isListLine(current)) {
        const listItems = [];
        while (i < lines.length && isListLine(lines[i])) {
          listItems.push(`<li>${renderInline(stripListMarker(lines[i]))}</li>`);
          i += 1;
        }
        parts.push(`<ul>${listItems.join('')}</ul>`);
        continue;
      }

      const paragraphLines = [current];
      i += 1;
      while (
        i < lines.length
        && !isListLine(lines[i])
        && !(lines[i].includes('|') && isTableDivider(lines[i + 1] || ''))
      ) {
        paragraphLines.push(lines[i]);
        i += 1;
      }
      parts.push(`<p>${renderInline(paragraphLines.join('<br>'))}</p>`);
    }

    return parts.join('');
  });

  return restoreMathSegments(formattedBlocks.join(''), protectedMath.mathParts);
}

function renderMathInContainer(container) {
  if (!container || !window.renderMathInElement) return;
  if (!container.innerHTML.trim()) return;
  try {
    window.renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true }
      ],
      throwOnError: false
    });
    container.querySelectorAll('.katex-display').forEach((node) => {
      if (node.parentElement && !node.parentElement.classList.contains('math-scroll-wrap')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'math-scroll-wrap';
        node.parentElement.insertBefore(wrapper, node);
        wrapper.appendChild(node);
      }
    });
  } catch (_e) {
    // ignore
  }
}

function highlightCodeInContainer(container) {
  if (!container || !window.hljs) return;
  container.querySelectorAll('pre.code-block code').forEach((block) => {
    try {
      window.hljs.highlightElement(block);
    } catch (_e) {
      // ignore
    }
  });
}

function getGenerationId() {
  const url = new URL(window.location.href);
  const queryGenerationId = url.searchParams.get('generation_id') || '';
  if (queryGenerationId) return queryGenerationId;

  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'material' && pathParts[1]) {
    return decodeURIComponent(pathParts[1]);
  }

  return '';
}

function percentClass(value) {
  if (value >= 70) return 'good';
  if (value >= 40) return 'medium';
  return 'low';
}

function getQuizSubtopics() {
  const subtopics = new Set();
  quizData.forEach((q) => {
    if (q.subtopic) subtopics.add(q.subtopic);
  });
  return Array.from(subtopics);
}

function findSummaryIndex(subtopic) {
  const target = (subtopic || '').trim().toLowerCase();
  if (!target) return -1;
  return summaryData.findIndex((section) => (section.subtopic || '').trim().toLowerCase() === target);
}

function truncateLabel(text, maxLength = 30) {
  const value = text || '';
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}

function switchToSummarySubtopic(subtopic) {
  activeSummarySubtopic = subtopic || '';
  const idx = findSummaryIndex(subtopic);
  const shouldRender = !panels.summary.classList.contains('active-pane');
  tabBtns.forEach((item) => item.classList.toggle('active', item.getAttribute('data-tab') === 'summary'));
  Object.values(panels).forEach((panel) => panel.classList.remove('active-pane'));
  panels.summary.classList.add('active-pane');
  if (shouldRender) {
    renderSummary();
  } else {
    syncSummarySelection();
  }
  if (idx >= 0) {
    setTimeout(() => {
      document.getElementById(`summary-section-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 40);
  }
}

function reviseButtonHtml(subtopic) {
  const idx = findSummaryIndex(subtopic);
  if (!subtopic || idx < 0) return '';
  return `
    <div class="next-btn-container">
      <button id="reviseSubtopicBtn" class="next-question-btn text-truncate" title="${escapeHtml(subtopic)}">Повторить тему «${escapeHtml(truncateLabel(subtopic))}»</button>
    </div>
  `;
}

function buildCheckPayload() {
  return {
    quiz: Array.isArray(quizData) ? quizData : [],
    answers: quizData.map((q, idx) => {
      const qid = String(q.question_id || idx + 1);
      const qtype = q.question_type === 'open_ended' || q.question_type === 'open_question' ? 'open_question' : 'multiple_choice';
      const subtopic = q.subtopic || `Подтема ${idx + 1}`;
      const answerState = quizState.answers[qid] || {};

      if (qtype === 'multiple_choice') {
        const selected = answerState.answer;
        const correctAnswer = Number(q.correct_answer);
        return {
          question_id: qid,
          question_type: 'multiple_choice',
          subtopic,
          is_correct: Number.isInteger(selected) && selected === correctAnswer
        };
      }

      return {
        question_id: qid,
        question_type: 'open_question',
        subtopic,
        question_text: q.question_text || '',
        correct_answer: q.correct_answer || '',
        student_answer: typeof answerState.answer === 'string' ? answerState.answer : ''
      };
    })
  };
}

function buildMastery(results) {
  const stats = new Map();
  (results || []).forEach((item) => {
    const subtopic = item.subtopic || 'Без темы';
    const current = stats.get(subtopic) || { correct: 0, total: 0 };
    current.correct += item.score ? 1 : 0;
    current.total += 1;
    stats.set(subtopic, current);
  });

  return Array.from(stats.entries()).map(([subtopic, stat]) => ({
    subtopic,
    percent: stat.total ? Math.round((stat.correct / stat.total) * 100) : 0
  }));
}

function hideQuizLoader() {
  const loader = quizContainer.querySelector('.quiz-final-loader');
  if (loader) loader.remove();
}

function renderQuizResults(data) {
  hideQuizLoader();
  const resultBox = document.getElementById('quizCheckResult');
  if (!resultBox) return;

  const masteryRaw = Array.isArray(data.mastery) ? data.mastery : buildMastery(Array.isArray(data.results) ? data.results : []);
  const allSubtopics = getQuizSubtopics();
  const masteryMap = new Map();
  masteryRaw.forEach((item) => {
    if (!allSubtopics.includes(item.subtopic)) return;
    const existing = masteryMap.get(item.subtopic);
    if (!existing || item.percent < existing.percent) {
      masteryMap.set(item.subtopic, item);
    }
  });
  const filteredMastery = Array.from(masteryMap.values());
  const weakSubtopics = Array.isArray(data.recommendations) && data.recommendations.length
    ? data.recommendations.map((item) => String(item.subtopic || '').trim()).filter(Boolean)
    : filteredMastery.filter((item) => Number(item.percent || 0) < 80).map((item) => String(item.subtopic || '').trim()).filter(Boolean);
  const practiceAction = getPracticeActionState();
  const rowsHtml = filteredMastery
    .map((item) => {
      const levelClass = percentClass(item.percent);
      return `
        <div class="quiz-result-row">
          <div class="quiz-result-subtopic">${escapeHtml(item.subtopic)}</div>
          <div class="quiz-result-progress-line">
            <div class="quiz-result-progress-fill ${levelClass}" style="width:${item.percent}%"></div>
          </div>
          <div class="quiz-result-percent">${item.percent}%</div>
        </div>
      `;
    })
    .join('');

  resultBox.innerHTML = `
    <div class="quiz-results-card">
      <h3>Результаты теста</h3>
      <div class="quiz-results-grid">${rowsHtml || '<div class="status-message">Нет данных для анализа.</div>'}</div>
      ${practiceAction ? `
        <div class="practice-action-row">
          <button class="next-question-btn" type="button" ${practiceAction.disabled ? 'disabled' : 'onclick="startPracticeSummary()"'}>${escapeHtml(practiceAction.label)}</button>
        </div>
      ` : ''}
    </div>
  `;
  setTimeout(() => renderMathInContainer(resultBox), 30);
}

function renderQuizCheckError(message) {
  hideQuizLoader();
  const resultBox = document.getElementById('quizCheckResult');
  if (!resultBox) return;
  resultBox.innerHTML = `
    <div class="quiz-results-card">
      <h3>Не удалось проверить тест</h3>
      <div class="quiz-result-recommendation">${escapeHtml(message || 'Попробуйте отправить ответы на проверку еще раз.')}</div>
      <div class="next-btn-container error-action-row"><button id="retryQuizCheckBtn" class="next-question-btn">Попробовать еще раз</button></div>
    </div>
  `;
  const retryBtn = document.getElementById('retryQuizCheckBtn');
  if (retryBtn) retryBtn.addEventListener('click', submitQuiz);
}

function renderQuizAnalysisLoader(target) {
  target.innerHTML = `
    <div class="quiz-final-loader">
      <div class="quiz-spinner"></div>
      <div class="quiz-final-loader-title">Анализируем результаты...</div>
      <div class="quiz-final-loader-subtitle">Проверяем ответы и собираем статистику по подтемам</div>
    </div>
    <div id="quizCheckResult"></div>
  `;
}

function getQuizItemRoot() {
  return quizContainer.querySelector(`.quiz-item[data-question-idx="${quizState.index}"]`);
}

function applySelectedAnswer(answerIdx) {
  const root = getQuizItemRoot();
  const q = quizData[quizState.index];
  if (!root || !q) return;

  const options = Array.from(root.querySelectorAll('.quiz-option'));
  const correctIndex = Number(q.correct_answer);
  const isCorrect = answerIdx === correctIndex;

  root.classList.add('is-answered');
  options.forEach((node, idx) => {
    node.classList.remove('correct-highlight', 'wrong-highlight', 'is-selected');
    if (idx === correctIndex) node.classList.add('correct-highlight');
    if (idx === answerIdx && !isCorrect) node.classList.add('wrong-highlight');
    if (idx === answerIdx) node.classList.add('is-selected');
  });

  if (!isCorrect) {
    const feedback = root.querySelector('[data-quiz-feedback]');
    if (feedback) feedback.hidden = false;
    const nextBtn = root.querySelector('[data-next-question-btn]');
    if (nextBtn) nextBtn.hidden = false;
  } else {
    setTimeout(() => nextQuestion(), 450);
  }
}

function updateQuizSelection(answerIdx) {
  const root = getQuizItemRoot();
  const q = quizData[quizState.index];
  if (!root || !q) return;

  const options = Array.from(root.querySelectorAll('.quiz-option'));
  const correctIndex = Number(q.correct_answer);
  const isCorrect = answerIdx === correctIndex;

  root.classList.add('is-answered');
  options.forEach((node, idx) => {
    node.classList.remove('correct-highlight', 'wrong-highlight', 'is-selected');
    if (idx === correctIndex) node.classList.add('correct-highlight');
    if (idx === answerIdx && !isCorrect) node.classList.add('wrong-highlight');
    if (idx === answerIdx) node.classList.add('is-selected');
  });

  if (!isCorrect) {
    const feedback = root.querySelector('[data-quiz-feedback]');
    if (feedback) feedback.hidden = false;
    const nextBtn = root.querySelector('[data-next-question-btn]');
    if (nextBtn) nextBtn.hidden = false;
  } else {
    setTimeout(() => nextQuestion(), 450);
  }
}

function renderQuiz() {
  if (!quizData.length) {
    quizContainer.innerHTML = '<div class="status-message">Тест недоступен</div>';
    return;
  }

  if (quizState.reviewMode && quizState.checkResult) {
    quizContainer.innerHTML = '<div id="quizCheckResult"></div>';
    renderQuizResults(quizState.checkResult);
    return;
  }

  if (quizState.index >= quizData.length) {
    if (quizState.checkStatus === 'done' && quizState.checkResult) {
      renderQuizResults(quizState.checkResult);
      return;
    }
    if (quizState.checkStatus === 'failed' && quizState.checkResult) {
      renderQuizCheckError(quizState.checkResult.recommendation || 'Не удалось проверить тест.');
      return;
    }
    if (quizState.checkStatus !== 'checking') {
      quizState.checkStatus = 'checking';
      renderQuizAnalysisLoader(quizContainer);
      setTimeout(() => submitQuiz(), 0);
      return;
    }
    renderQuizAnalysisLoader(quizContainer);
    return;
  }

  const q = quizData[quizState.index];
  const qid = String(q.question_id || quizState.index + 1);
  const answered = quizState.answers[qid] && quizState.answers[qid].answered;
  const open = q.question_type === 'open_ended' || q.question_type === 'open_question';

  let html = `<div class="quiz-item" data-question-idx="${quizState.index}">
    <div class="quiz-question">${quizState.index + 1}. ${markdownInlineToHtmlQuiz(q.question_text || '')}</div>`;

  if (open) {
    if (!answered) {
      html += '<div class="open-ended-area"><textarea id="openAnswer" class="open-ended-input" rows="4" placeholder="Введите ваш ответ..."></textarea><button class="check-answer-btn" id="checkAnswerBtn">Проверить ответ</button></div>';
    } else {
      html += `<div class="open-ended-area"><textarea class="open-ended-input" rows="4" disabled>${escapeHtml(quizState.answers[qid].answer || '')}</textarea></div>`;
      html += `<div class="explanation-box"><strong>Эталонный ответ:</strong><br>${markdownInlineToHtmlQuiz(q.correct_answer || '')}</div>`;
      html += '<div class="next-btn-container"><button class="next-question-btn" type="button">Далее</button></div>';
    }
  } else {
    const options = Array.isArray(q.options) ? q.options : [];
    for (let i = 0; i < options.length; i++) {
      html += `<div class="quiz-option" data-opt-index="${i}"><label>${markdownInlineToHtmlQuiz(options[i] || '')}</label></div>`;
    }
    html += `
      <div class="quiz-feedback" data-quiz-feedback hidden>
        <div class="explanation-box"><strong>Объяснение:</strong><br>${markdownInlineToHtmlQuiz(q.explanation || '')}</div>
        <div class="next-btn-container"><button class="next-question-btn" type="button">Далее</button></div>
      </div>
    `;
  }

  html += '</div>';
  quizContainer.innerHTML = html;

  if (!open) {
    quizContainer.querySelectorAll('.quiz-option').forEach((node) => {
      node.addEventListener('click', () => {
        const idx = parseInt(node.getAttribute('data-opt-index'), 10);
        selectAnswer(idx);
      });
    });
  }

  const checkBtn = document.getElementById('checkAnswerBtn');
  if (checkBtn) checkBtn.addEventListener('click', checkOpenEndedAnswer);

  const nextBtn = quizContainer.querySelector('.next-question-btn');
  if (nextBtn) {
    nextBtn.onclick = function() {
      if (quizState.index >= quizData.length) return;
      nextQuestion();
    };
  }

  if (!open && answered) {
    applySelectedAnswer(quizState.answers[qid].answer);
  }

  setTimeout(() => renderMathInContainer(quizContainer), 30);
}

function syncSummarySelection() {
  if (!summaryContainer) return;
  const active = normalizeTextBreaks(activeSummarySubtopic).trim().toLowerCase();
  summaryContainer.querySelectorAll('.toc-item').forEach((item) => {
    const isActive = normalizeTextBreaks(item.getAttribute('data-subtopic') || '').trim().toLowerCase() === active;
    item.classList.toggle('active', isActive);
  });
  summaryContainer.querySelectorAll('.summary-section').forEach((section) => {
    const isActive = active !== '' && normalizeTextBreaks(section.getAttribute('data-subtopic') || '').trim().toLowerCase() === active;
    section.classList.toggle('is-active', isActive);
  });
}

function clearSummarySelection() {
  activeSummarySubtopic = '';
  syncSummarySelection();
}

function renderPractice() {
  renderPracticeSummary();
}

function buildSummaryLayoutHtml(sections, { includeToc = true, sectionClassName = 'summary-section', headingTag = 'h3', headingPrefix = 'Раздел', tocTitle = 'Оглавление', emptyMessage = 'Конспект недоступен' } = {}) {
  const items = Array.isArray(sections) ? sections : [];
  if (!items.length) {
    return `<div class="status-message">${escapeHtml(emptyMessage)}</div>`;
  }

  if (!includeToc) {
    return `
      <div class="summary-content">
        ${items.map((section, idx) => `
          <section class="${sectionClassName}" data-subtopic="${escapeHtml(section.subtopic || '')}">
            <${headingTag}>${escapeHtml(section.subtopic || `${headingPrefix} ${idx + 1}`)}</${headingTag}>
            <div class="content">${formatMarkdownToHtml(section.content || '')}</div>
          </section>
        `).join('')}
      </div>
    `;
  }

  let tocHtml = `<div class="summary-toc"><h4>${escapeHtml(tocTitle)}</h4><ul class="toc-list">`;
  let contentHtml = '<div class="summary-content">';
  for (let idx = 0; idx < items.length; idx++) {
    const section = items[idx];
    const id = `summary-section-${idx}`;
    tocHtml += `<li class="toc-item" data-subtopic="${escapeHtml(section.subtopic || '')}" data-section-id="${id}">${escapeHtml(section.subtopic || `${headingPrefix} ${idx + 1}`)}</li>`;
    contentHtml += `<section id="${id}" class="${sectionClassName}" data-subtopic="${escapeHtml(section.subtopic || '')}"><${headingTag}>${escapeHtml(section.subtopic || `${headingPrefix} ${idx + 1}`)}</${headingTag}><div class="content">${formatMarkdownToHtml(section.content || '')}</div></section>`;
  }
  tocHtml += '</ul></div>';
  contentHtml += '</div>';
  return `<div class="summary-layout">${tocHtml}${contentHtml}</div>`;
}

function renderSummary() {
  summaryContainer.innerHTML = buildSummaryLayoutHtml(summaryData, { includeToc: true, emptyMessage: 'Конспект недоступен' });
  if (!summaryData.length) return;
  summaryContainer.querySelectorAll('.toc-item').forEach((item) => {
    item.addEventListener('click', () => {
      activeSummarySubtopic = item.getAttribute('data-subtopic') || '';
      syncSummarySelection();
      setTimeout(() => {
        document.getElementById(item.getAttribute('data-section-id'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 40);
    });
  });
  syncSummarySelection();
  setTimeout(() => {
    renderMathInContainer(summaryContainer);
    highlightCodeInContainer(summaryContainer);
  }, 30);
}

function renderPracticeSummary() {
  if (!practiceContainer) return;

  const summary = Array.isArray(practiceData.summary) ? practiceData.summary : [];
  if (practiceData.status === 'idle' && !summary.length) {
    practiceContainer.innerHTML = '<div class="status-message">Практика появится после прохождения теста</div>';
    return;
  }
  if (practiceData.status === 'processing_summary') {
    practiceContainer.innerHTML = `
      <div class="practice-layout">
        <div class="practice-summary-card">
          <div class="practice-status">Готовим практический конспект...</div>
        </div>
        <div class="practice-quiz-card" id="practiceQuizArea">
          <div class="quiz-final-loader">
            <div class="quiz-spinner"></div>
            <div class="quiz-final-loader-title">Готовим практику...</div>
            <div class="quiz-final-loader-subtitle">Подбираем материалы по слабым подтемам</div>
          </div>
        </div>
      </div>
    `;
    return;
  }
  if (practiceData.status === 'stale') {
    practiceContainer.innerHTML = `
      <div class="practice-layout">
        <div class="practice-summary-card">
          <div class="practice-status">${escapeHtml(practiceData.stale_reason || 'Практика устарела после изменений в тесте или конспекте.')}</div>
        </div>
      </div>
    `;
    return;
  }
  if (practiceData.status === 'failed' && practiceData.stage === 'summary' && !summary.length) {
    practiceContainer.innerHTML = `
      <div class="practice-layout">
        <div class="practice-summary-card">
          <div class="practice-status">${escapeHtml(practiceData.error_message || 'Не удалось собрать практический конспект.')}</div>
          <div class="practice-action-row">
            <button class="next-question-btn" type="button" onclick="startPracticeSummary()">Попробовать еще раз</button>
          </div>
        </div>
      </div>
    `;
    return;
  }
  if (!summary.length) {
    practiceContainer.innerHTML = '<div class="status-message">Практика пока недоступна</div>';
    return;
  }

  const summaryHtml = buildSummaryLayoutHtml(summary, {
    includeToc: false,
    sectionClassName: 'practice-section',
    headingTag: 'h4',
    headingPrefix: 'Раздел',
    emptyMessage: 'Практика пока недоступна'
  });

  if (practiceData.round_submitted) {
    const isFinal = practiceData.practice_completed || !(Array.isArray(practiceData.pending_weak_subtopics) && practiceData.pending_weak_subtopics.length);
    const pendingText = Array.isArray(practiceData.pending_weak_subtopics) && practiceData.pending_weak_subtopics.length
      ? `Остались темы: ${escapeHtml(practiceData.pending_weak_subtopics.join(', '))}.`
      : 'Все темы уже закреплены выше порога.';
    practiceContainer.innerHTML = `
      <div class="practice-layout">
        <div class="practice-summary-card" id="practiceSummaryArea">
          <h3>Практический конспект</h3>
          ${summaryHtml}
          <div class="practice-status">${isFinal ? 'Практика завершена.' : `Раунд завершен. ${pendingText}`}</div>
          <div class="practice-action-row">
            <button class="next-question-btn" type="button" ${isFinal ? 'disabled' : 'onclick="startPracticeSummary()"'}>${isFinal ? 'Практика пройдена' : 'Продолжить практику'}</button>
          </div>
        </div>
        <div class="practice-quiz-card">
          <div class="quiz-complete">${isFinal ? 'Все темы закреплены. Можно вернуться к материалу или пересмотреть конспект.' : 'Текущий раунд завершен. Можно продолжить практику.'}</div>
        </div>
      </div>
    `;
    setTimeout(() => {
      renderMathInContainer(practiceContainer);
      highlightCodeInContainer(practiceContainer);
    }, 30);
    return;
  }
  if (practiceData.practice_completed) {
    practiceContainer.innerHTML = `
      <div class="practice-layout">
        <div class="practice-summary-card" id="practiceSummaryArea">
          <h3>Практический конспект</h3>
          ${summaryHtml}
          <div class="practice-status">Практика пройдена.</div>
          <div class="practice-action-row">
            <button class="next-question-btn" type="button" disabled>Практика пройдена</button>
          </div>
        </div>
        <div class="practice-quiz-card">
          <div class="quiz-complete">Все темы уже закреплены выше 80%.</div>
        </div>
      </div>
    `;
    setTimeout(() => {
      renderMathInContainer(practiceContainer);
      highlightCodeInContainer(practiceContainer);
    }, 30);
    return;
  }

  const quizPanelHtml = practiceData.status === 'processing_quiz'
    ? `
      <div class="practice-quiz-card" id="practiceQuizArea">
        <div class="quiz-final-loader">
          <div class="quiz-spinner"></div>
          <div class="quiz-final-loader-title">Генерируем практику...</div>
          <div class="quiz-final-loader-subtitle">Собираем задания на основе практического конспекта</div>
        </div>
      </div>
    `
    : (practiceData.status === 'failed' && practiceData.stage === 'quiz'
      ? `
        <div class="practice-quiz-card" id="practiceQuizArea">
          <div class="practice-status">${escapeHtml(practiceData.error_message || 'Не удалось сгенерировать практический тест.')}</div>
          <div class="practice-action-row">
            <button class="next-question-btn" type="button" onclick="startPracticeQuiz()">Попробовать еще раз</button>
          </div>
        </div>
      `
      : '<div class="practice-quiz-card" id="practiceQuizArea"></div>');

  practiceContainer.innerHTML = `
    <div class="practice-layout">
      <div class="practice-summary-card" id="practiceSummaryArea">
        <h3>Практический конспект</h3>
        ${summaryHtml}
      </div>
      ${quizPanelHtml}
    </div>
  `;

  setTimeout(() => {
    renderMathInContainer(practiceContainer);
    highlightCodeInContainer(practiceContainer);
  }, 30);

  if (Array.isArray(practiceData.quiz) && practiceData.quiz.length && practiceData.status !== 'processing_quiz') {
    renderPracticeQuiz();
  }
}

function getPracticeQuizRoot() {
  if (!practiceContainer) return null;
  const area = practiceContainer.querySelector('#practiceQuizArea');
  if (!area) return null;
  return area.querySelector(`.quiz-item[data-question-idx="${practiceQuizState.index}"]`);
}

function applyPracticeSelectedAnswer(answerIdx) {
  const root = getPracticeQuizRoot();
  const q = Array.isArray(practiceData.quiz) ? practiceData.quiz[practiceQuizState.index] : null;
  if (!root || !q) return;

  const options = Array.from(root.querySelectorAll('.quiz-option'));
  const correctIndex = Number(q.correct_answer);
  const isCorrect = answerIdx === correctIndex;

  root.classList.add('is-answered');
  options.forEach((node, idx) => {
    node.classList.remove('correct-highlight', 'wrong-highlight', 'is-selected');
    if (idx === correctIndex) node.classList.add('correct-highlight');
    if (idx === answerIdx && !isCorrect) node.classList.add('wrong-highlight');
    if (idx === answerIdx) node.classList.add('is-selected');
  });

  if (!isCorrect) {
    const feedback = root.querySelector('[data-quiz-feedback]');
    if (feedback) feedback.hidden = false;
    const nextBtn = root.querySelector('[data-next-question-btn]');
    if (nextBtn) nextBtn.hidden = false;
  } else {
    setTimeout(() => nextPracticeQuestion(), 450);
  }
}

function renderPracticeQuiz() {
  if (!practiceContainer) return;
  const quizArea = practiceContainer.querySelector('#practiceQuizArea');
  const quiz = Array.isArray(practiceData.quiz) ? practiceData.quiz : [];
  if (practiceQuizState.submitting && quizArea) {
    quizArea.innerHTML = `
      <div class="quiz-final-loader">
        <div class="quiz-spinner"></div>
        <div class="quiz-final-loader-title">Проверяем практику...</div>
        <div class="quiz-final-loader-subtitle">Смотрим, какие темы уже можно убрать из очереди</div>
      </div>
    `;
    return;
  }
  if (!quiz.length) {
    if (quizArea) {
      quizArea.innerHTML = '<div class="status-message">Практический тест появится после генерации</div>';
    }
    return;
  }

  if (practiceQuizState.finished || practiceQuizState.index >= quiz.length) {
    if (quizArea) {
      quizArea.innerHTML = '<div class="quiz-complete">Практика завершена. Можно вернуться к конспекту или повторить задания.</div>';
    }
    setTimeout(() => {
      renderMathInContainer(quizArea || practiceContainer);
      highlightCodeInContainer(quizArea || practiceContainer);
    }, 30);
    return;
  }

  const q = quiz[practiceQuizState.index];
  const qid = String(q.question_id || practiceQuizState.index + 1);
  const answered = practiceQuizState.answers[qid] && practiceQuizState.answers[qid].answered;
  const open = q.question_type === 'open_ended' || q.question_type === 'open_question';

  let html = `<div class="quiz-item" data-question-idx="${practiceQuizState.index}"><div class="quiz-question">${practiceQuizState.index + 1}. ${markdownInlineToHtmlQuiz(q.question_text || '')}</div>`;

  if (open) {
    if (!answered) {
      html += '<div class="open-ended-area"><textarea id="practiceOpenAnswer" class="open-ended-input" rows="4" placeholder="Введите ваш ответ..."></textarea><button class="check-answer-btn" id="practiceCheckAnswerBtn">Проверить ответ</button></div>';
    } else {
      html += `<div class="open-ended-area"><textarea class="open-ended-input" rows="4" disabled>${escapeHtml(practiceQuizState.answers[qid].answer || '')}</textarea></div>`;
      html += `<div class="explanation-box"><strong>Эталонный ответ:</strong><br>${markdownInlineToHtmlQuiz(q.correct_answer || '')}</div>`;
      html += '<div class="next-btn-container"><button class="next-question-btn" type="button">Далее</button></div>';
    }
  } else {
    const options = Array.isArray(q.options) ? q.options : [];
    for (let i = 0; i < options.length; i++) {
      html += `<div class="quiz-option" data-opt-index="${i}"><label>${markdownInlineToHtmlQuiz(options[i] || '')}</label></div>`;
    }
    html += `
      <div class="quiz-feedback" data-quiz-feedback hidden>
        <div class="explanation-box"><strong>Объяснение:</strong><br>${markdownInlineToHtmlQuiz(q.explanation || '')}</div>
        <div class="next-btn-container"><button class="next-question-btn" type="button">Далее</button></div>
      </div>
    `;
  }

  html += '</div>';
  if (quizArea) {
    quizArea.innerHTML = html;
  } else {
    practiceContainer.innerHTML = html;
  }
  const targetRoot = quizArea || practiceContainer;

  if (!open) {
    targetRoot.querySelectorAll('.quiz-option').forEach((node) => {
      node.addEventListener('click', () => {
        const idx = parseInt(node.getAttribute('data-opt-index'), 10);
        selectPracticeAnswer(idx);
      });
    });
  }

  const checkBtn = document.getElementById('practiceCheckAnswerBtn');
  if (checkBtn) checkBtn.addEventListener('click', checkPracticeOpenEndedAnswer);

  const nextBtn = targetRoot.querySelector('.next-question-btn');
  if (nextBtn) {
    nextBtn.onclick = function() {
      if (practiceQuizState.index >= quiz.length) return;
      nextPracticeQuestion();
    };
  }

  if (!open && answered) {
    applyPracticeSelectedAnswer(practiceQuizState.answers[qid].answer);
  }

  setTimeout(() => renderMathInContainer(targetRoot), 30);
}

window.selectPracticeAnswer = function selectPracticeAnswer(answerIdx) {
  const q = Array.isArray(practiceData.quiz) ? practiceData.quiz[practiceQuizState.index] : null;
  if (!q) return;
  const qid = String(q.question_id || practiceQuizState.index + 1);
  if (practiceQuizState.answers[qid] && practiceQuizState.answers[qid].answered) return;
  practiceQuizState.answers[qid] = { answer: answerIdx, answered: true };
  applyPracticeSelectedAnswer(answerIdx);
};

window.checkPracticeOpenEndedAnswer = function checkPracticeOpenEndedAnswer() {
  const q = Array.isArray(practiceData.quiz) ? practiceData.quiz[practiceQuizState.index] : null;
  if (!q) return;
  const input = document.getElementById('practiceOpenAnswer');
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  const qid = String(q.question_id || practiceQuizState.index + 1);
  practiceQuizState.answers[qid] = { answer: val, answered: true };

  const root = getPracticeQuizRoot();
  if (!root) {
    renderPracticeQuiz();
    return;
  }

  const openArea = root.querySelector('.open-ended-area');
  if (openArea) {
    openArea.innerHTML = `<textarea class="open-ended-input" rows="4" disabled>${escapeHtml(val)}</textarea>`;
  }

  const explanationHtml = markdownInlineToHtmlQuiz(q.correct_answer || '');
  const explanationBox = document.createElement('div');
  explanationBox.className = 'explanation-box';
  explanationBox.innerHTML = `<strong>Эталонный ответ:</strong><br>${explanationHtml}`;
  root.appendChild(explanationBox);

  const nextContainer = document.createElement('div');
  nextContainer.className = 'next-btn-container';
  nextContainer.innerHTML = '<button class="next-question-btn" type="button">Далее</button>';
  root.appendChild(nextContainer);

  const nextBtn = nextContainer.querySelector('.next-question-btn');
  if (nextBtn) {
    nextBtn.onclick = function() {
      if (practiceQuizState.index >= practiceData.quiz.length) return;
      nextPracticeQuestion();
    };
  }

  setTimeout(() => renderMathInContainer(root), 30);
};

window.nextPracticeQuestion = function nextPracticeQuestion() {
  if (!Array.isArray(practiceData.quiz) || practiceQuizState.index >= practiceData.quiz.length) {
    submitPracticeRound();
    return;
  }
  if (practiceQuizState.index + 1 < practiceData.quiz.length) practiceQuizState.index += 1;
  else submitPracticeRound();
  renderPracticeQuiz();
};

async function submitPracticeRound() {
  if (practiceQuizState.submitting) return;
  practiceQuizState.submitting = true;
  renderPracticeQuiz();

  try {
    const data = await api(`/api/student/${generationId}/practice/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPracticeCompletionPayload())
    });
    if (data && data.practice) {
      setPracticeState(data.practice);
    }
    practiceQuizState.index = 0;
    practiceQuizState.answers = {};
    practiceQuizState.finished = false;
    practiceQuizState.submitting = false;
    renderPracticeSummary();
  } catch (e) {
    practiceQuizState.submitting = false;
    practiceQuizState.finished = true;
    if (practiceContainer) {
      const quizArea = practiceContainer.querySelector('#practiceQuizArea');
      if (quizArea) {
        quizArea.innerHTML = `
          <div class="practice-status">${escapeHtml(e.message || 'Не удалось сохранить результат практики.')}</div>
          <div class="practice-action-row">
            <button class="next-question-btn" type="button" onclick="submitPracticeRound()">Попробовать еще раз</button>
          </div>
        `;
      }
    }
  }
}

async function startPracticeSummary() {
  const actionState = getPracticeActionState();
  if (actionState && actionState.kind === 'done') {
    openPracticeTab();
    ensurePracticeTabVisible();
    renderActiveTab('practice');
    renderPracticeSummary();
    return;
  }
  const isContinue = actionState && actionState.kind === 'continue';
  const payload = isContinue ? {} : buildPracticeQuestionsPayload();
  if (!isContinue && !payload.weak_subtopics.length) {
    showPopover('Сначала нужен результат теста с рекомендациями по подтемам.');
    return;
  }
  openPracticeTab();
  ensurePracticeTabVisible();
  renderActiveTab('practice');
  setPracticeState({ status: 'processing_summary', stage: 'summary', error_message: '', stale_reason: '' });
  renderPracticeSummary();

  try {
    const data = await api(`/api/student/${generationId}/practice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (data && data.practice) {
      setPracticeState(data.practice);
    }
    practiceQuizState.index = 0;
    practiceQuizState.answers = {};
    practiceQuizState.finished = false;
    practiceQuizState.submitting = false;
    renderPracticeSummary();
    if (Array.isArray(practiceData.summary) && practiceData.summary.length && !practiceData.round_submitted) {
      await startPracticeQuiz();
    }
  } catch (e) {
    setPracticeState({ status: 'failed', stage: 'summary', error_message: e.message || 'Не удалось сгенерировать практический конспект.' });
    renderPracticeSummary();
  }
}

async function startPracticeQuiz() {
  if (practiceData.practice_completed && (!Array.isArray(practiceData.pending_weak_subtopics) || !practiceData.pending_weak_subtopics.length)) {
    openPracticeTab();
    ensurePracticeTabVisible();
    renderActiveTab('practice');
    renderPracticeSummary();
    return;
  }
  if (practiceData.status === 'completed' && Array.isArray(practiceData.quiz) && practiceData.quiz.length && !practiceData.round_submitted) {
    openPracticeTab();
    ensurePracticeTabVisible();
    renderActiveTab('practice');
    renderPracticeSummary();
    return;
  }
  if (practiceData.status === 'idle' && !practiceData.summary.length) {
    await startPracticeSummary();
    return;
  }
  if (!Array.isArray(practiceData.summary) || !practiceData.summary.length) {
    showPopover('Сначала нужно сгенерировать практический конспект.');
    return;
  }
  openPracticeTab();
  ensurePracticeTabVisible();
  renderActiveTab('practice');
  setPracticeState({ status: 'processing_quiz', stage: 'quiz', error_message: '', stale_reason: '' });
  renderPracticeSummary();

  try {
    const data = await api(`/api/student/${generationId}/practice/quiz`, {
      method: 'POST'
    });
    if (data && data.practice) {
      setPracticeState(data.practice);
    }
    practiceQuizState.index = 0;
    practiceQuizState.answers = {};
    practiceQuizState.finished = false;
    practiceQuizState.submitting = false;
    renderPracticeSummary();
  } catch (e) {
    setPracticeState({ status: 'failed', stage: 'quiz', error_message: e.message || 'Не удалось сгенерировать практический тест.' });
    renderPracticeSummary();
  }
}

async function submitQuiz() {
  const resultBox = document.getElementById('quizCheckResult');
  if (!resultBox) return;

  try {
    const res = await fetch(`/api/student/${generationId}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCheckPayload())
    });

    const data = await res.json();
    if (!res.ok) {
      quizState.checkStatus = 'failed';
      quizState.checkResult = { recommendation: data.detail || 'Не удалось проверить тест.' };
      renderQuizCheckError(data.detail || 'Не удалось проверить тест.');
      return;
    }

    quizState.checkStatus = 'done';
    quizState.checkResult = data;
    renderQuizResults(data);
  } catch (_e) {
    quizState.checkStatus = 'failed';
    quizState.checkResult = { recommendation: 'Ошибка сети при проверке теста.' };
    renderQuizCheckError('Ошибка сети при проверке теста.');
  }
}

function getStorageKey() {
  return `quiz_progress_${generationId}`;
}

function saveQuizProgress() {
  if (!generationId) return;
  const payload = {
    index: quizState.index,
    answers: quizState.answers,
    checkStatus: quizState.checkStatus,
    checkResult: quizState.checkResult,
    reviewMode: quizState.reviewMode
  };
  try {
    localStorage.setItem(getStorageKey(), JSON.stringify(payload));
  } catch (_e) {
    // ignore
  }
}

function loadQuizProgress() {
  if (!generationId) return;
  try {
    const raw = localStorage.getItem(getStorageKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.index === 'number') quizState.index = data.index;
    if (data.answers) quizState.answers = data.answers;
    if (data.checkStatus) quizState.checkStatus = data.checkStatus;
    if (data.checkResult) quizState.checkResult = data.checkResult;
    if (typeof data.reviewMode === 'boolean') quizState.reviewMode = data.reviewMode;
  } catch (_e) {
    // ignore
  }
}

function clearQuizProgress() {
  if (!generationId) return;
  try {
    localStorage.removeItem(getStorageKey());
  } catch (_e) {
    // ignore
  }
}

function initQuizState() {
  quizState.index = 0;
  quizState.answers = {};
  quizState.checkStatus = 'idle';
  quizState.checkResult = null;
  quizState.reviewMode = false;
}

function renderActiveTab(tabName) {
  tabBtns.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName));
  Object.values(panels).forEach((panel) => panel.classList.remove('active-pane'));
  panels[tabName].classList.add('active-pane');
  if (tabName === 'summary') renderSummary();
  if (tabName === 'quiz') renderQuiz();
  if (tabName === 'practice') renderPractice();
}

function bindEvents() {
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      renderActiveTab(tab);
    });
  });
}

window.selectAnswer = function selectAnswer(answerIdx) {
  const q = quizData[quizState.index];
  if (!q) return;
  const qid = String(q.question_id || quizState.index + 1);
  if (quizState.answers[qid] && quizState.answers[qid].answered) return;
  quizState.answers[qid] = { answer: answerIdx, answered: true };
  saveQuizProgress();
  updateQuizSelection(answerIdx);
};

window.checkOpenEndedAnswer = function checkOpenEndedAnswer() {
  const q = quizData[quizState.index];
  if (!q) return;
  const input = document.getElementById('openAnswer');
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  const qid = String(q.question_id || quizState.index + 1);
  quizState.answers[qid] = { answer: val, answered: true };
  saveQuizProgress();

  const root = getQuizItemRoot();
  if (!root || !q) {
    renderQuiz();
    return;
  }

  const openArea = root.querySelector('.open-ended-area');
  if (openArea) {
    openArea.innerHTML = `<textarea class="open-ended-input" rows="4" disabled>${escapeHtml(val)}</textarea>`;
  }

  const explanationHtml = markdownInlineToHtmlQuiz(q.correct_answer || '');
  const explanationBox = document.createElement('div');
  explanationBox.className = 'explanation-box';
  explanationBox.innerHTML = `<strong>Эталонный ответ:</strong><br>${explanationHtml}`;
  root.appendChild(explanationBox);

  const nextContainer = document.createElement('div');
  nextContainer.className = 'next-btn-container';
  nextContainer.innerHTML = '<button class="next-question-btn" type="button">Далее</button>';
  root.appendChild(nextContainer);

  const nextBtn = nextContainer.querySelector('.next-question-btn');
  if (nextBtn) {
    nextBtn.onclick = function() {
      if (quizState.index >= quizData.length) return;
      nextQuestion();
    };
  }

  setTimeout(() => renderMathInContainer(root), 30);
};

window.nextQuestion = function nextQuestion() {
  if (quizState.index >= quizData.length) return;
  if (quizState.index + 1 < quizData.length) quizState.index += 1;
  else quizState.index = quizData.length;
  saveQuizProgress();
  renderQuiz();
};

(async function init() {
  generationId = getGenerationId();
  if (!generationId) {
    summaryContainer.innerHTML = '<div class="status-message">Ссылка недействительна</div>';
    quizContainer.innerHTML = '<div class="status-message">Ссылка недействительна</div>';
    return;
  }

  const res = await fetch(`/api/student/${generationId}`);
  if (!res.ok) {
    summaryContainer.innerHTML = '<div class="status-message">Материал недоступен</div>';
    quizContainer.innerHTML = '<div class="status-message">Материал недоступен</div>';
    return;
  }

  const data = await res.json();
  summaryData = Array.isArray(data.summary) ? data.summary : [];
  quizData = Array.isArray(data.quiz) ? data.quiz : [];
  practiceData = normalizePracticeState(data.practice);
  initQuizState();
  practiceQuizState.index = 0;
  practiceQuizState.answers = {};
  practiceQuizState.finished = false;
  practiceQuizState.submitting = false;
  clearSummarySelection();
  if (practiceHasVisibleState()) ensurePracticeTabVisible();
  if (data.attempt) {
    quizState.reviewMode = true;
    quizState.checkStatus = 'done';
    quizState.checkResult = data.attempt;
    clearQuizProgress();
  } else {
    loadQuizProgress();
  }
  bindEvents();
  renderSummary();
  renderQuiz();
})();

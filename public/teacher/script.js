const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadStatusDiv = document.getElementById('uploadStatus');
const generateBtn = document.getElementById('generateBtn');
const resetUploadBtn = document.getElementById('resetUploadBtn');
const transcriptContainer = document.getElementById('transcriptContainer');
const transcriptJumpBtn = document.getElementById('transcriptJumpBtn');
const summaryContainer = document.getElementById('summaryContainer');
const quizContainer = document.getElementById('quizContainer');
const practiceContainer = document.getElementById('practiceContainer');
const analyticsContainer = document.getElementById('analyticsContainer');
const editSummaryBtn = document.getElementById('editSummaryBtn');
const editQuizBtn = document.getElementById('editQuizBtn');
const summaryTabBtn = document.getElementById('summaryTabBtn');
const quizTabBtn = document.getElementById('quizTabBtn');
const practiceTabBtn = document.getElementById('practiceTabBtn');
const analyticsTabBtn = document.getElementById('analyticsTabBtn');
const historyList = document.getElementById('historyList');
const historyListMobile = document.getElementById('historyListMobile');
const historyToggleBtn = document.getElementById('historyToggleBtn');
const historySidebar = document.querySelector('.history-sidebar');
const pageLayout = document.querySelector('.page-layout');
const historyDrawer = document.getElementById('historyDrawer');
const historyOverlay = document.getElementById('historyOverlay');
const closeHistoryBtn = document.getElementById('closeHistoryBtn');

const tabBtns = document.querySelectorAll('.tab-btn');
const panels = {
  transcript: document.getElementById('panelTranscript'),
  summary: document.getElementById('panelSummary'),
  quiz: document.getElementById('panelQuiz'),
  practice: document.getElementById('panelPractice'),
  analytics: document.getElementById('panelAnalytics')
};

const STATUS_LABELS = {
  processing: 'Обработка...',
  queued: 'В очереди',
  completed: 'Готово',
  failed: 'Ошибка'
};
const SPEECH_ANALYSIS_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const SPEECH_ANALYSIS_POLL_INTERVAL_MS = 3000;

const requestedGenerationId = new URL(window.location.href).searchParams.get('generation_id') || '';

let selectedFile = null;
let meUserId = '';
let generations = [];
let activeGenerationId = null;
let neutralMode = false;
let activeSummarySubtopic = '';
const generationUiState = {};
let ws = null;
let wsReconnectTimer = null;
let wsReconnectAttempt = 0;
let transcriptJumpRaf = 0;
let requestedGenerationCache = null;
let activeTranscriptHighlight = {
  generationId: '',
  startMs: null,
  endMs: null
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

function normalizeSpeechTitle(title) {
  const value = String(title || '').trim();
  if (value === 'Преподаватель активно задаёт вопросы студентам') return 'Вопросы преподавателя';
  if (value === 'Преподаватель реагирует на ответы студентов и развивает обсуждение') return 'Ответы студентов';
  return value;
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

function practiceHasVisibleState(gen) {
  const practice = normalizePracticeState(gen && gen.practice ? gen.practice : {});
  return Boolean(
    practice.status !== 'idle'
    || practice.round_submitted
    || practice.practice_completed
    || (Array.isArray(practice.summary) && practice.summary.length)
    || (Array.isArray(practice.quiz) && practice.quiz.length)
    || (Array.isArray(practice.pending_weak_subtopics) && practice.pending_weak_subtopics.length)
    || (gen && gen.ui && gen.ui.practiceTabOpened)
  );
}

function showPopover(message) {
  const existing = document.querySelector('.global-popover');
  if (existing) existing.remove();
  const popover = document.createElement('div');
  popover.className = 'global-popover';
  popover.textContent = message;
  document.body.appendChild(popover);
  requestAnimationFrame(() => popover.classList.add('visible'));
  setTimeout(() => {
    popover.classList.remove('visible');
    setTimeout(() => popover.remove(), 200);
  }, 2400);
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

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatTime(ms) {
  const sec = Math.floor((ms || 0) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function normalizeTranscriptLines(transcript) {
  const lines = [];
  (Array.isArray(transcript) ? transcript : []).forEach((item) => {
    if (!item) return;
    if (Array.isArray(item.transcript)) {
      item.transcript.forEach((segment) => {
        if (!segment) return;
        const startMs = Number(segment.start_ms || 0);
        const text = String(segment.text || '').trim();
        if (!text) return;
        const line = { start_ms: Number.isNaN(startMs) ? 0 : startMs, text };
        if (segment.speaker) {
          line.speaker = String(segment.speaker).trim();
        }
        lines.push(line);
      });
      return;
    }
    const startMs = Number(item.start_ms || 0);
    const text = String(item.text || '').trim();
    if (!text) return;
    const line = { start_ms: Number.isNaN(startMs) ? 0 : startMs, text };
    if (item.speaker) {
      line.speaker = String(item.speaker).trim();
    }
    lines.push(line);
  });
  lines.sort((a, b) => a.start_ms - b.start_ms);
  return lines;
}

function normalizeSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^0-9a-zа-яё]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sampleTranscriptSnippet(lines, index, fallback) {
  if (!Array.isArray(lines) || !lines.length) return fallback;
  const item = lines[Math.max(0, index) % lines.length];
  const text = String(item && item.text ? item.text : '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 110 ? text.slice(0, 110).trim() : text;
}

function normalizeFragmentRange(fragment) {
  const startMs = Number(fragment && fragment.start_ms !== undefined ? fragment.start_ms : NaN);
  const endMsRaw = Number(fragment && fragment.end_ms !== undefined ? fragment.end_ms : startMs);
  const hasStart = Number.isFinite(startMs);
  const hasEnd = Number.isFinite(endMsRaw);
  if (!hasStart && !hasEnd) {
    return { startMs: null, endMs: null };
  }
  const start = hasStart ? startMs : endMsRaw;
  const end = hasEnd ? endMsRaw : start;
  return start <= end
    ? { startMs: start, endMs: end }
    : { startMs: end, endMs: start };
}

function formatSpeechFragmentType(type) {
  const value = String(type || '').trim().toLowerCase();
  const labels = {
    example: 'пример',
    analogy: 'аналогия',
    metaphor: 'метафора',
    storytelling: 'сторителлинг'
  };
  return labels[value] || '';
}

function formatSpeechFragmentTypeTitle(type) {
  const value = formatSpeechFragmentType(type);
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getActiveTranscriptHighlight(gen) {
  if (!gen || activeTranscriptHighlight.generationId !== gen.id) return null;
  const startMs = Number(activeTranscriptHighlight.startMs);
  const endMs = Number(activeTranscriptHighlight.endMs);
  if (!Number.isFinite(startMs)) return null;
  return {
    startMs,
    endMs: Number.isFinite(endMs) ? endMs : startMs
  };
}

function setActiveTranscriptHighlight(gen, startMs, endMs = null) {
  const startValue = Number(startMs);
  const endValue = Number(endMs);
  if (!gen || !Number.isFinite(startValue)) {
    activeTranscriptHighlight = { generationId: '', startMs: null, endMs: null };
    return;
  }
  const normalizedEnd = Number.isFinite(endValue) ? endValue : startValue;
  activeTranscriptHighlight = {
    generationId: gen.id,
    startMs: startValue,
    endMs: normalizedEnd >= startValue ? normalizedEnd : startValue
  };
}

function getSpeechAnalysisAggregate(gen) {
  const analytics = gen && gen.analytics && typeof gen.analytics === 'object' ? gen.analytics : null;
  if (!analytics) return null;
  const speech = analytics.speech_analysis;
  if (!speech || typeof speech !== 'object') return null;
  return speech;
}

function getSpeechAnalysisError(gen) {
  const analytics = gen && gen.analytics && typeof gen.analytics === 'object' ? gen.analytics : null;
  if (!analytics) return '';
  return String(analytics.speech_analysis_error || '').trim();
}

const ALLOWED_QUESTION_TYPES = new Set([
  'rhetorical',
  'checking_understanding',
  'quiz',
  'clarifying',
  'open_ended',
  'factual',
  'other'
]);

function normalizeQuestionType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  const aliases = {
    rhetorical: 'rhetorical',
    'риторический': 'rhetorical',
    checking_understanding: 'checking_understanding',
    'проверка понимания': 'checking_understanding',
    quiz: 'quiz',
    'викторина': 'quiz',
    clarifying: 'clarifying',
    'уточняющий': 'clarifying',
    open_ended: 'open_ended',
    'open-ended': 'open_ended',
    'открытый': 'open_ended',
    factual: 'factual',
    'фактический': 'factual',
    other: 'other',
    'другой': 'other'
  };
  return aliases[normalized] || (ALLOWED_QUESTION_TYPES.has(normalized) ? normalized : 'other');
}

function formatQuestionTypeLabel(value) {
  const normalized = normalizeQuestionType(value);
  const labels = {
    rhetorical: 'риторический',
    checking_understanding: 'проверка понимания',
    quiz: 'викторина',
    clarifying: 'уточняющий',
    open_ended: 'открытый',
    factual: 'фактический',
    other: 'другой'
  };
  return labels[normalized] || '';
}

function normalizeSpeechAnalysisFragment(fragment) {
  if (!fragment || typeof fragment !== 'object') {
    const text = String(fragment || '').trim();
    return { start_ms: 0, end_ms: 0, text };
  }
  const startMs = Number(fragment.start_ms);
  const endMs = Number(fragment.end_ms);
  const safeStart = Number.isFinite(startMs) ? startMs : 0;
  const safeEnd = Number.isFinite(endMs) ? Math.max(safeStart, endMs) : safeStart;
  const normalized = {
    start_ms: safeStart,
    end_ms: safeEnd,
    text: String(fragment.text || '').trim()
  };
  const type = String(fragment.type || '').trim();
  if (type) normalized.type = type;
  const questionType = normalizeQuestionType(fragment.question_type);
  if (questionType) normalized.question_type = questionType;
  return normalized;
}

function mergeSpeechAnalysisFragments(primary, secondary) {
  const merged = [];
  const seen = new Set();
  [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])].forEach((fragment) => {
    const normalized = normalizeSpeechAnalysisFragment(fragment);
    if (!normalized.text) return;
    const key = `${normalized.start_ms}|${normalized.end_ms}|${normalized.text}|${normalized.type || ''}|${normalized.question_type || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(normalized);
  });
  return merged;
}

function chunkAnalysesFromRaw(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.chunk_analyses)) return [];
  return raw.chunk_analyses.filter((chunk) => chunk && typeof chunk === 'object');
}

function flattenChunkField(chunkAnalyses, field) {
  const fragments = [];
  chunkAnalyses.forEach((chunk) => {
    const items = Array.isArray(chunk[field]) ? chunk[field] : [];
    items.forEach((item) => fragments.push(normalizeSpeechAnalysisFragment(item)));
  });
  return fragments;
}

function buildSpeechAnalysisViewModel(gen) {
  const raw = getSpeechAnalysisAggregate(gen);
  if (!raw) return null;
  const chunkAnalyses = chunkAnalysesFromRaw(raw);
  const lessonFormatRaw = raw.lesson_format && typeof raw.lesson_format === 'object' ? raw.lesson_format : {};
  const legacyAudience = raw.audience_engagement && typeof raw.audience_engagement === 'object' ? raw.audience_engagement : {};
  const legacyStructure = raw.lesson_structure && typeof raw.lesson_structure === 'object' ? raw.lesson_structure : {};
  const legacyExplanation = raw.material_explanation && typeof raw.material_explanation === 'object' ? raw.material_explanation : {};
  const legacyRecommendation = raw.teacher_recommendation && typeof raw.teacher_recommendation === 'object' ? raw.teacher_recommendation : {};
  const legacyFlags = raw.flags && typeof raw.flags === 'object' ? raw.flags : {};
  const legacyQuestions = legacyAudience.questions_to_students && typeof legacyAudience.questions_to_students === 'object' ? legacyAudience.questions_to_students : {};
  const legacyAnswers = legacyAudience.student_answers && typeof legacyAudience.student_answers === 'object' ? legacyAudience.student_answers : {};
  const legacyTimeline = legacyStructure.step_by_step_explanation && typeof legacyStructure.step_by_step_explanation === 'object' ? legacyStructure.step_by_step_explanation : {};
  const legacyGoals = legacyStructure.goals_and_summary && typeof legacyStructure.goals_and_summary === 'object' ? legacyStructure.goals_and_summary : {};
  const legacyExamples = legacyExplanation.examples_and_analogies && typeof legacyExplanation.examples_and_analogies === 'object' ? legacyExplanation.examples_and_analogies : {};
  const derivedQuestions = flattenChunkField(chunkAnalyses, 'teacher_questions');
  const derivedAnswers = flattenChunkField(chunkAnalyses, 'student_answers');
  const derivedExamples = flattenChunkField(chunkAnalyses, 'examples_and_analogies');
  const derivedTimeline = [];
  const derivedIntro = { present: false, start_ms: null, comment: '' };
  const derivedSummary = { present: false, start_ms: null, comment: '' };
  const derivedFlags = {
    profanity: [],
    familiarity: []
  };
  chunkAnalyses.forEach((chunk) => {
    const events = Array.isArray(chunk.lesson_events) ? chunk.lesson_events : [];
    events.forEach((event) => {
      if (!event || typeof event !== 'object') return;
      const startMs = Number(event.start_ms);
      const safeStart = Number.isFinite(startMs) ? startMs : 0;
      derivedTimeline.push({
        start_ms: safeStart,
        time: formatTime(safeStart),
        title: String(event.title || 'Событие урока').trim(),
        comment: String(event.description || '').trim()
      });
    });
    const goals = chunk.goals_and_summary && typeof chunk.goals_and_summary === 'object' ? chunk.goals_and_summary : {};
    const intro = goals.intro && typeof goals.intro === 'object' ? goals.intro : {};
    const summary = goals.summary && typeof goals.summary === 'object' ? goals.summary : {};
    if (intro.present && !derivedIntro.present) {
      derivedIntro.present = true;
      derivedIntro.start_ms = intro.start_ms ?? null;
      derivedIntro.comment = String(intro.comment || '').trim();
    }
    if (summary.present && !derivedSummary.present) {
      derivedSummary.present = true;
      derivedSummary.start_ms = summary.start_ms ?? null;
      derivedSummary.comment = String(summary.comment || '').trim();
    }
    const flags = chunk.flags && typeof chunk.flags === 'object' ? chunk.flags : {};
    if (Array.isArray(flags.profanity)) derivedFlags.profanity.push(...flags.profanity);
    if (Array.isArray(flags.overly_familiar_tone)) derivedFlags.familiarity.push(...flags.overly_familiar_tone);
  });
  derivedTimeline.sort((a, b) => Number(a.start_ms || 0) - Number(b.start_ms || 0));
  const formatLabel = String(lessonFormatRaw.format || '').trim() || (chunkAnalyses.length ? 'Агрегированный результат анализа речи преподавателя' : 'Формат занятия не определен');
  const formatComment = String(lessonFormatRaw.comment || '').trim() || (chunkAnalyses.length ? `Проанализировано чанков: ${chunkAnalyses.length}` : 'Агрегированный анализ речи преподавателя готов.');
  return {
    format: {
      label: formatLabel,
      comment: formatComment,
    },
    engagement: {
      questions: {
        title: normalizeSpeechTitle(legacyQuestions.title || 'Вопросы преподавателя'),
        comment: String(legacyQuestions.comment || ''),
        fragments: mergeSpeechAnalysisFragments(legacyQuestions.fragments, derivedQuestions)
      },
      answers: {
        title: normalizeSpeechTitle(legacyAnswers.title || 'Ответы студентов'),
        comment: String(legacyAnswers.comment || ''),
        fragments: mergeSpeechAnalysisFragments(legacyAnswers.fragments, derivedAnswers)
      }
    },
    structure: {
      timeline: {
        title: String(legacyTimeline.title || 'Таймлайн урока'),
        items: Array.isArray(legacyTimeline.timeline) && legacyTimeline.timeline.length
          ? legacyTimeline.timeline.map((item) => ({
              time: String(item && item.time ? item.time : formatTime(Number(item && item.start_ms ? item.start_ms : 0))),
              title: String(item && item.title ? item.title : 'Событие урока'),
              comment: String(item && (item.description || item.comment) ? (item.description || item.comment) : '')
            }))
          : derivedTimeline
      },
      goals: {
        title: String(legacyGoals.title || 'Цели и итоги урока'),
        introduction: {
          passed: Boolean(legacyGoals.intro && legacyGoals.intro.present) || derivedIntro.present,
          comment: String(legacyGoals.intro && legacyGoals.intro.comment ? legacyGoals.intro.comment : derivedIntro.comment || '')
        },
        ending: {
          passed: Boolean(legacyGoals.summary && legacyGoals.summary.present) || derivedSummary.present,
          comment: String(legacyGoals.summary && legacyGoals.summary.comment ? legacyGoals.summary.comment : derivedSummary.comment || '')
        }
      }
    },
    explanation: {
      title: String(legacyExamples.title || 'Примеры, аналогии и сторителлинг'),
      fragments: mergeSpeechAnalysisFragments(legacyExamples.fragments, derivedExamples)
    },
    recommendation: {
      title: String(legacyRecommendation.title || 'Рекомендация преподавателю'),
      comment: String(legacyRecommendation.comment || '')
    },
    flags: {
      profanity: {
        title: String(legacyFlags.profanity && legacyFlags.profanity.title ? legacyFlags.profanity.title : 'Ненормативная лексика'),
        passed: Boolean(legacyFlags.profanity && legacyFlags.profanity.present) || derivedFlags.profanity.length > 0,
        fragments: mergeSpeechAnalysisFragments(legacyFlags.profanity && legacyFlags.profanity.fragments, derivedFlags.profanity)
      },
      familiarity: {
        title: String(legacyFlags.overly_familiar_tone && legacyFlags.overly_familiar_tone.title ? legacyFlags.overly_familiar_tone.title : 'Панибратство'),
        passed: Boolean(legacyFlags.overly_familiar_tone && legacyFlags.overly_familiar_tone.present) || derivedFlags.familiarity.length > 0,
        fragments: mergeSpeechAnalysisFragments(legacyFlags.overly_familiar_tone && legacyFlags.overly_familiar_tone.fragments, derivedFlags.familiarity)
      }
    }
  };
}

function getGenerationAgeMs(gen) {
  if (!gen || !gen.created_at) return 0;
  const createdAt = new Date(gen.created_at);
  if (Number.isNaN(createdAt.getTime())) return 0;
  return Math.max(0, Date.now() - createdAt.getTime());
}

function getSpeechAnalysisState(gen) {
  if (!gen) return null;
  if (!gen.ui) gen.ui = {};
  if (!gen.ui.speechAnalysisExpanded || typeof gen.ui.speechAnalysisExpanded !== 'object') {
    gen.ui.speechAnalysisExpanded = {};
  }
  return gen.ui.speechAnalysisExpanded;
}

function buildSpeechAnalysisPrototype(gen) {
  const transcriptLines = normalizeTranscriptLines(gen && gen.transcript ? gen.transcript : []);
  const questionSnippets = [
    sampleTranscriptSnippet(transcriptLines, 0, 'Как вы думаете, почему это важно?'),
    sampleTranscriptSnippet(transcriptLines, 3, 'Можно привести другой пример из практики?'),
    sampleTranscriptSnippet(transcriptLines, 6, 'Почему здесь возникает именно такой вывод?'),
    'Как вы думаете, почему это важно?',
    'Можно привести другой пример из практики?',
    'Почему здесь возникает именно такой вывод?'
  ];
  const answerSnippets = [
    sampleTranscriptSnippet(transcriptLines, 1, 'Студент отвечает коротко и по существу.'),
    sampleTranscriptSnippet(transcriptLines, 4, 'Ответ студентов становится более уверенным после уточнения вопроса.'),
    sampleTranscriptSnippet(transcriptLines, 7, 'Есть аккуратная попытка сформулировать мысль своими словами.'),
    'Студент отвечает коротко и по существу.',
    'Ответ студентов становится более уверенным после уточнения вопроса.',
    'Есть аккуратная попытка сформулировать мысль своими словами.'
  ];
  const explanationSnippets = [
    sampleTranscriptSnippet(transcriptLines, 2, 'Преподаватель объясняет через пример и короткую аналогию.'),
    sampleTranscriptSnippet(transcriptLines, 5, 'Сначала идет правило, затем мягкое уточнение и иллюстрация.'),
    sampleTranscriptSnippet(transcriptLines, 8, 'Объяснение строится последовательно и без лишнего усложнения.'),
    'Преподаватель объясняет через пример и короткую аналогию.',
    'Сначала идет правило, затем мягкое уточнение и иллюстрация.',
    'Объяснение строится последовательно и без лишнего усложнения.'
  ];
  const profanitySnippets = [
    sampleTranscriptSnippet(transcriptLines, 10, 'Здесь встречается резкая формулировка, которую стоит смягчить.'),
    sampleTranscriptSnippet(transcriptLines, 12, 'Наблюдается слишком разговорный тон в адрес аудитории.'),
    'Здесь встречается резкая формулировка, которую стоит смягчить.',
    'Наблюдается слишком разговорный тон в адрес аудитории.'
  ];
  const familiaritySnippets = [
    sampleTranscriptSnippet(transcriptLines, 11, 'Используется дружеское обращение, которое может звучать панибратски.'),
    sampleTranscriptSnippet(transcriptLines, 13, 'Обращение к студентам слишком фамильярное для академического контекста.'),
    'Используется дружеское обращение, которое может звучать панибратски.',
    'Обращение к студентам слишком фамильярное для академического контекста.'
  ];

  return {
    format: {
      label: 'Смешанный формат с диалогом и короткими уточнениями',
      comment: 'Преподаватель не только объясняет материал, но и периодически втягивает аудиторию в мини-диалог, чтобы удерживать внимание и быстро проверять понимание.'
    },
    engagement: {
      questions: {
        title: 'Вопросы преподавателя',
        fragments: questionSnippets.map((text) => ({ text }))
      },
      answers: {
        title: 'Ответы студентов',
        fragments: answerSnippets.map((text) => ({ text }))
      }
    },
    structure: {
      timeline: {
        title: 'Таймлайн урока',
        items: [
          { time: '00:00–01:10', title: 'Вход в тему', comment: 'Преподаватель обозначает рамку и быстро возвращает группу к базовому контексту.' },
          { time: '01:10–03:00', title: 'Ключевое объяснение', comment: 'Материал раскрывается последовательно, с опорой на одно центральное правило.' },
          { time: '03:00–04:30', title: 'Проверка понимания', comment: 'После объяснения следуют уточняющие вопросы и короткая сверка реакции аудитории.' },
          { time: '04:30–06:00', title: 'Закрепление примером', comment: 'Преподаватель переводит теорию в практический пример и упрощает формулировки.' }
        ]
      },
      goals: {
        title: 'Цели и итоги урока',
        introduction: {
          passed: true,
          comment: 'В начале занятия преподаватель быстро обозначает, чему именно будет посвящен фокус урока.'
        },
        ending: {
          passed: false,
          comment: ''
        }
      }
    },
    explanation: {
      title: 'Примеры, аналогии и сторителлинг',
      fragments: explanationSnippets.map((text) => ({ text }))
    },
    flags: {
      profanity: {
        title: 'Ненормативная лексика',
        passed: false,
        fragments: profanitySnippets.map((text) => ({ text }))
      },
      familiarity: {
        title: 'Панибратство',
        passed: true,
        fragments: familiaritySnippets.map((text) => ({ text }))
      }
    }
  };
}

function renderSpeechFragment(fragment, gen, sectionKey, index, transcriptLines = []) {
  const text = String(fragment && fragment.text ? fragment.text : fragment || '').trim();
  if (!text) return '';
  const range = normalizeFragmentRange(fragment);
  const startMs = range.startMs;
  const endMs = range.endMs;
  const lineExists = Number.isFinite(startMs)
    && transcriptLines.some((line) => {
      const lineStart = Number(line.start_ms || 0);
      return Number.isFinite(lineStart) && lineStart >= startMs && lineStart <= (Number.isFinite(endMs) ? endMs : startMs);
    });
  const typeLabel = formatSpeechFragmentType(fragment && fragment.type);
  const questionTypeLabel = sectionKey === 'engagement_questions'
    ? formatQuestionTypeLabel(fragment && fragment.question_type)
    : '';
  const labelHtml = [
    typeLabel ? ` <span class="speech-fragment-type">(${escapeHtml(typeLabel)})</span>` : '',
    questionTypeLabel ? ` <span class="speech-fragment-type speech-question-type">[${escapeHtml(questionTypeLabel)}]</span>` : ''
  ].join('');
  if (!lineExists) {
    return `<span class="speech-fragment-text">${escapeHtml(text)}${labelHtml}</span>`;
  }
  return `
    <button
      type="button"
      class="speech-fragment-link"
      data-speech-fragment="true"
      data-speech-start-ms="${escapeHtml(startMs)}"
      data-speech-end-ms="${escapeHtml(Number.isFinite(endMs) ? endMs : startMs)}"
      data-speech-section="${escapeHtml(sectionKey)}"
      data-speech-index="${index}"
      aria-label="Перейти к фрагменту в транскрипте"
      title="Перейти к фрагменту в транскрипте"
    >${escapeHtml(text)}${labelHtml}</button>
  `;
}

function renderSpeechFragmentList(fragments, gen, sectionKey, expanded = false, transcriptLines = []) {
  const items = Array.isArray(fragments) ? fragments : [];
  const visibleItems = items.slice(0, 10);
  const hiddenItems = items.slice(10);
  const hiddenCount = hiddenItems.length;
  const visibleHtml = visibleItems
    .map((fragment, index) => renderSpeechFragment(fragment, gen, sectionKey, index, transcriptLines))
    .filter(Boolean)
    .map((fragmentHtml, index) => `<div class="speech-fragment-line" data-speech-section="${escapeHtml(sectionKey)}" data-speech-index="${index}">${fragmentHtml}</div>`)
    .join('');
  const hiddenHtml = hiddenItems
    .map((fragment, index) => renderSpeechFragment(fragment, gen, sectionKey, index + 10, transcriptLines))
    .filter(Boolean)
    .map((fragmentHtml, index) => `<div class="speech-fragment-line" data-speech-section="${escapeHtml(sectionKey)}" data-speech-index="${index + 10}">${fragmentHtml}</div>`)
    .join('');
  const moreBlockHtml = hiddenCount > 0
    ? `
      <details class="speech-fragment-more">
        <summary class="speech-fragment-more-btn">Показать еще (${hiddenCount})</summary>
        <div class="speech-fragment-hidden">
          ${hiddenHtml}
        </div>
      </details>
    `
    : '';
  return `
    <div class="speech-fragment-list-wrap">
      <div class="speech-fragment-list">${visibleHtml}</div>
      ${moreBlockHtml}
    </div>
  `;
}

function renderSpeechCheck(title, value) {
  const passed = Boolean(value && value.passed);
  const label = passed ? '✓' : '✕';
  const cls = passed ? 'speech-check yes' : 'speech-check no';
  const comment = passed && value.comment
    ? `<span class="speech-check-comment-inline">${escapeHtml(value.comment)}</span>`
    : '';
  return `
    <div class="speech-check-row">
      <span class="speech-check-label">${escapeHtml(title || '')}</span>
      <span class="${cls}">${label}</span>
    </div>
    ${comment ? `<div class="speech-check-comment-inline">${escapeHtml(value.comment)}</div>` : ''}
  `;
}

function renderSpeechGoal(label, goal) {
  const passed = Boolean(goal && goal.passed);
  return `
    <div class="speech-goal-row">
      <div class="speech-goal-head">
        <div class="speech-goal-label">${escapeHtml(label)}</div>
        <div class="speech-goal-badge ${passed ? 'yes' : 'no'}">${passed ? '✓' : '✕'}</div>
      </div>
      ${passed && goal.comment ? `<div class="speech-goal-comment">${escapeHtml(goal.comment)}</div>` : ''}
    </div>
  `;
}

function renderSpeechTimeline(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => `
      <div class="speech-timeline-item">
        <div class="speech-timeline-time">${escapeHtml(item.time || '')}</div>
        <div class="speech-timeline-body">
          <div class="speech-timeline-title">${escapeHtml(item.title || '')}</div>
          <div class="speech-timeline-comment">${escapeHtml(item.comment || '')}</div>
        </div>
      </div>
    `)
    .join('');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeWorksheetName(name, fallback = 'Лист') {
  const cleaned = String(name || fallback)
    .replace(/[\[\]\*\/\\\?:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 31) || fallback;
}

function transcriptFragmentExportData(fragment, transcriptLines) {
  const text = String(fragment && fragment.text ? fragment.text : fragment || '').trim();
  if (!text) {
    return {
      fragment: '',
      found: 'Нет',
      transcriptText: '',
      timestamp: ''
    };
  }
  const range = normalizeFragmentRange(fragment);
  const startMs = range.startMs;
  const endMs = range.endMs;
  const match = Number.isFinite(startMs)
    ? transcriptLines.find((line) => {
        const lineStart = Number(line.start_ms || 0);
        return Number.isFinite(lineStart) && lineStart >= startMs && lineStart <= (Number.isFinite(endMs) ? endMs : startMs);
      })
    : null;
  const typeLabel = formatSpeechFragmentType(fragment && fragment.type);
  const fragmentText = typeLabel ? `${text} (${typeLabel})` : text;
  const timestamp = Number.isFinite(startMs)
    ? (Number.isFinite(endMs) && endMs > startMs ? `${formatTime(startMs)}–${formatTime(endMs)}` : formatTime(startMs))
    : '';
  return {
    fragment: fragmentText,
    found: match ? 'Да' : 'Нет',
    transcriptText: match ? (match.speaker ? `${match.speaker}: ${match.text}` : String(match.text || '')) : '',
    timestamp: match ? timestamp : (Number.isFinite(startMs) ? timestamp : '')
  };
}

function buildSpeechAnalysisExportSheets(gen) {
  const transcriptLines = normalizeTranscriptLines(gen && gen.transcript ? gen.transcript : []);
  const speech = buildSpeechAnalysisViewModel(gen);
  if (!speech) return [];

  const overviewRows = [
    ['Параметр', 'Значение'],
    ['Формат занятия', speech.format.label],
    ['Комментарий', speech.format.comment],
  ];

  const engagementRows = [
    ['Подблок', 'Тип вопроса', 'Фрагмент', 'Найден в транскрипте', 'Время', 'Текст совпадения']
  ];
  [
    ['Вопросы преподавателя', speech.engagement.questions.fragments],
    ['Ответы студентов', speech.engagement.answers.fragments]
  ].forEach(([sectionTitle, fragments]) => {
    fragments.forEach((fragment) => {
      const data = transcriptFragmentExportData(fragment, transcriptLines);
      engagementRows.push([
        sectionTitle,
        sectionTitle === 'Вопросы преподавателя' ? formatQuestionTypeLabel(fragment.question_type) : '',
        data.fragment,
        data.found,
        data.timestamp,
        data.transcriptText
      ]);
    });
  });

  const recommendationRows = [
    ['Подблок', 'Параметр', 'Значение', 'Найден в транскрипте', 'Время', 'Текст совпадения']
  ];
  recommendationRows.push(['Рекомендация преподавателю', 'Заголовок', speech.recommendation.title, '', '', '']);
  recommendationRows.push(['Рекомендация преподавателю', 'Комментарий', speech.recommendation.comment, '', '', '']);
  recommendationRows.push(['Вопросы преподавателя', 'Заголовок', speech.engagement.questions.title, '', '', '']);
  recommendationRows.push(['Вопросы преподавателя', 'Комментарий', speech.engagement.questions.comment || '', '', '', '']);
  speech.engagement.questions.fragments.forEach((fragment) => {
    const data = transcriptFragmentExportData(fragment, transcriptLines);
    recommendationRows.push(['Вопросы преподавателя', `Фрагмент${fragment.question_type ? ` (${formatQuestionTypeLabel(fragment.question_type)})` : ''}`, data.fragment, data.found, data.timestamp, data.transcriptText]);
  });
  recommendationRows.push(['Ответы студентов', 'Заголовок', speech.engagement.answers.title, '', '', '']);
  recommendationRows.push(['Ответы студентов', 'Комментарий', speech.engagement.answers.comment || '', '', '', '']);
  speech.engagement.answers.fragments.forEach((fragment) => {
    const data = transcriptFragmentExportData(fragment, transcriptLines);
    recommendationRows.push(['Ответы студентов', 'Фрагмент', data.fragment, data.found, data.timestamp, data.transcriptText]);
  });

  const structureRows = [
    ['Подблок', 'Параметр', 'Значение']
  ];
  speech.structure.timeline.items.forEach((item) => {
    structureRows.push(['Таймлайн урока', item.time || '', `${item.title || ''}${item.comment ? ` — ${item.comment}` : ''}`]);
  });
  structureRows.push(['Цели и итоги урока', 'Введение', speech.structure.goals.introduction.passed ? `✓ ${speech.structure.goals.introduction.comment || ''}` : '✕']);
  structureRows.push(['Цели и итоги урока', 'Завершение', speech.structure.goals.ending.passed ? `✓ ${speech.structure.goals.ending.comment || ''}` : '✕']);

  const explanationRows = [
    ['Подблок', 'Фрагмент', 'Найден в транскрипте', 'Время', 'Текст совпадения']
  ];
  speech.explanation.fragments.forEach((fragment) => {
    const data = transcriptFragmentExportData(fragment, transcriptLines);
    explanationRows.push([formatSpeechFragmentTypeTitle(fragment && fragment.type), data.fragment, data.found, data.timestamp, data.transcriptText]);
  });

  const flagsRows = [
    ['Подблок', 'Фрагмент', 'Найден в транскрипте', 'Время', 'Текст совпадения']
  ];
  [
    [speech.flags.profanity.title, speech.flags.profanity],
    [speech.flags.familiarity.title, speech.flags.familiarity]
  ].forEach(([title, flag]) => {
    if (!flag.passed) {
      flagsRows.push([title, 'Фрагменты не показываются, так как флаг не подтвержден', 'Нет', '', '']);
      return;
    }
    flag.fragments.forEach((fragment) => {
      const data = transcriptFragmentExportData(fragment, transcriptLines);
      flagsRows.push([title, data.fragment, data.found, data.timestamp, data.transcriptText]);
    });
  });

  return [
    { name: 'Обзор', rows: overviewRows },
    { name: 'Рекомендации', rows: recommendationRows },
    { name: 'Вовлечение', rows: engagementRows },
    { name: 'Структура', rows: structureRows },
    { name: 'Объяснение', rows: explanationRows },
    { name: 'Флаги', rows: flagsRows }
  ];
}

function buildSpreadsheetXml(worksheets) {
  const sheetXml = (rows) => {
    const body = rows.map((row) => `
      <Row>
        ${row.map((cell) => `<Cell><Data ss:Type="String">${escapeXml(cell)}</Data></Cell>`).join('')}
      </Row>
    `).join('');
    return `<Table>${body}</Table>`;
  };

  const wsXml = (sheet) => `
    <Worksheet ss:Name="${escapeXml(sanitizeWorksheetName(sheet.name))}">
      ${sheetXml(sheet.rows || [])}
    </Worksheet>
  `;

  return `<?xml version="1.0"?>
  <?mso-application progid="Excel.Sheet"?>
  <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
            xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:x="urn:schemas-microsoft-com:office:excel"
            xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
            xmlns:html="http://www.w3.org/TR/REC-html40">
    <Styles>
      <Style ss:ID="Default" ss:Name="Normal">
        <Alignment ss:Vertical="Top"/>
        <Font ss:FontName="Arial" ss:Size="10"/>
      </Style>
    </Styles>
    ${worksheets.map(wsXml).join('\n')}
  </Workbook>`;
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportSpeechAnalysisToExcel(gen) {
  if (!gen) return;
  const exportId = String(gen.id || 'export').slice(0, 16);
  const baseName = `speech_analysis_${exportId}.xlsx`;
  const speechAnalysis = getSpeechAnalysisAggregate(gen);
  const transcript = Array.isArray(gen.transcript) ? gen.transcript : [];
  const downloadResponse = async (response) => {
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = baseName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  try {
    const response = await fetch(`/api/generations/${encodeURIComponent(gen.id)}/speech-analysis.xlsx`, {
      method: 'GET',
      credentials: 'same-origin'
    });
    if (!response.ok) {
      if (speechAnalysis) {
        const payloadResponse = await fetch(`/api/generations/${encodeURIComponent(gen.id)}/speech-analysis.xlsx`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            transcript,
            speech_analysis: speechAnalysis
          })
        });
        if (payloadResponse.ok) {
          await downloadResponse(payloadResponse);
          return;
        }
      }
      showPopover('Экспорт пока недоступен: анализ речи преподавателя ещё не готов.');
      return;
    }
    await downloadResponse(response);
  } catch (_error) {
    try {
      if (speechAnalysis) {
        const payloadResponse = await fetch(`/api/generations/${encodeURIComponent(gen.id)}/speech-analysis.xlsx`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            transcript,
            speech_analysis: speechAnalysis
          })
        });
        if (payloadResponse.ok) {
          await downloadResponse(payloadResponse);
          return;
        }
      }
    } catch (_payloadError) {
      // ignore and fall through to the user-facing message
    }
    showPopover('Не удалось скачать Excel-файл.');
  }
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

  html = formattedBlocks.join('');
  return restoreMathSegments(html, protectedMath.mathParts);
}

function formatMarkdownToHtmlEditor(text) {
  const source = escapeHtml(prepareSummaryTextForDisplay(text));
  const protectedMath = protectMathSegments(source);
  let html = protectedMath.text;

  const blocks = html.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);

  const formattedBlocks = blocks.map((block) => {
    const lines = block.split('\n').map((line) => line.trimEnd());
    const renderInline = (value) => String(value || '')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
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

function statusLabel(status) {
  return STATUS_LABELS[status] || 'Недоступно';
}

function normalizeText(value) {
  return (value || '').trim().toLowerCase();
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

function redirectToStudent(generationId) {
  const target = generationId ? `/material/${encodeURIComponent(generationId)}/` : '/material/';
  window.location.replace(new URL(target, window.location.origin).toString());
}

function getStudentLink(link) {
  try {
    return new URL(link, window.location.origin).toString();
  } catch (_e) {
    return link || '';
  }
}

async function copyStudentLink(link) {
  const target = getStudentLink(link);
  if (!target) return false;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(target);
    } else {
      const helper = document.createElement('textarea');
      helper.value = target;
      helper.setAttribute('readonly', 'readonly');
      helper.style.position = 'fixed';
      helper.style.left = '-9999px';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    return true;
  } catch (_e) {
    return false;
  }
}

const copyButtonRestoreTimers = new WeakMap();

function showCopyButtonState(button) {
  if (!button) return;
  const previousTimer = copyButtonRestoreTimers.get(button);
  if (previousTimer) window.clearTimeout(previousTimer);

  button.dataset.defaultLabel = button.dataset.defaultLabel || button.textContent || 'Скопировать';
  button.textContent = '✓ Скопировано';
  button.classList.add('copied');

  const timer = window.setTimeout(() => {
    button.textContent = button.dataset.defaultLabel || 'Скопировать';
    button.classList.remove('copied');
    copyButtonRestoreTimers.delete(button);
  }, 3000);

  copyButtonRestoreTimers.set(button, timer);
}

async function handleCopyStudentLink(button, link) {
  const copied = await copyStudentLink(link);
  if (copied) showCopyButtonState(button);
}

function openStudentLink(link) {
  const target = getStudentLink(link);
  if (!target) return;
  window.open(target, '_blank', 'noopener,noreferrer');
}

function getActiveGeneration() {
  return generations.find((g) => g.id === activeGenerationId) || null;
}

function getActiveTab() {
  const activeBtn = Array.from(tabBtns).find((btn) => btn.classList.contains('active'));
  return activeBtn ? (activeBtn.getAttribute('data-tab') || 'transcript') : 'transcript';
}

function setActiveTab(tab, gen = getActiveGeneration(), render = true) {
  tabBtns.forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-tab') === tab));
  Object.values(panels).forEach((panel) => panel.classList.remove('active-pane'));
  if (panels[tab]) panels[tab].classList.add('active-pane');

  if (!render) return;
  if (tab === 'transcript') renderTranscript(gen);
  if (tab === 'summary') renderSummary(gen);
  if (tab === 'quiz') renderQuiz(gen);
  if (tab === 'practice') renderPractice(gen);
  if (tab === 'analytics') renderAnalytics(gen);
}

function enrichGeneration(gen) {
  const prevUi = generationUiState[gen.id];
  const nextUi = prevUi || gen.ui || {
    isEditMode: false,
    isQuizEditMode: false,
    quizIndex: 0,
    quizAnswers: [],
    quizCheckStatus: 'idle',
    quizCheckResult: null,
    practicePromptVisible: false,
    practiceTabOpened: false,
    practiceRoundSubmitting: false,
    practiceQuizIndex: 0,
    practiceQuizAnswers: [],
    practiceQuizFinished: false,
    speechAnalysisRetryPending: false,
    speechAnalysisRetryStartedAt: 0,
    speechAnalysisExpanded: {}
  };
  if (!nextUi.quizCheckStatus) nextUi.quizCheckStatus = 'idle';
  if (!('quizCheckResult' in nextUi)) nextUi.quizCheckResult = null;
  if (typeof nextUi.practicePromptVisible !== 'boolean') nextUi.practicePromptVisible = false;
  if (typeof nextUi.practiceTabOpened !== 'boolean') nextUi.practiceTabOpened = false;
  if (typeof nextUi.practiceRoundSubmitting !== 'boolean') nextUi.practiceRoundSubmitting = false;
  if (typeof nextUi.practiceQuizIndex !== 'number') nextUi.practiceQuizIndex = 0;
  if (!Array.isArray(nextUi.practiceQuizAnswers)) nextUi.practiceQuizAnswers = [];
  if (typeof nextUi.practiceQuizFinished !== 'boolean') nextUi.practiceQuizFinished = false;
  if (typeof nextUi.speechAnalysisRetryPending !== 'boolean') nextUi.speechAnalysisRetryPending = false;
  if (typeof nextUi.speechAnalysisRetryStartedAt !== 'number') nextUi.speechAnalysisRetryStartedAt = 0;
  if (!nextUi.speechAnalysisExpanded || typeof nextUi.speechAnalysisExpanded !== 'object') nextUi.speechAnalysisExpanded = {};
  generationUiState[gen.id] = nextUi;
  return {
    ...gen,
    ui: nextUi
  };
}

function setTabLoader(tabBtn, show) {
  const loader = tabBtn && tabBtn.querySelector('.tab-loader');
  if (loader) loader.style.display = show ? 'inline-block' : 'none';
}

function setTabState(tabBtn, enabled, loading) {
  if (!tabBtn) return;
  tabBtn.disabled = !enabled;
  tabBtn.style.opacity = enabled ? '1' : '0.5';
  setTabLoader(tabBtn, loading);
}

function updateTabStates(gen) {
  if (!gen) {
    setTabState(summaryTabBtn, false, false);
    setTabState(quizTabBtn, false, false);
    setTabState(practiceTabBtn, false, false);
    setTabState(analyticsTabBtn, false, false);
    if (getActiveTab() !== 'transcript') setActiveTab('transcript', null, false);
    return;
  }

  const hasTranscript = Array.isArray(gen.transcript) && gen.transcript.length > 0;
  const hasSummary = Array.isArray(gen.summary) && gen.summary.length > 0;
  const hasQuiz = Array.isArray(gen.quiz) && gen.quiz.length > 0;
  const hasSpeechAnalysis = Boolean(getSpeechAnalysisAggregate(gen));
  const speechRetryPending = Boolean(gen.ui && gen.ui.speechAnalysisRetryPending);
  const practice = normalizePracticeState(gen.practice || {});
  const practiceVisible = Boolean(
    gen.ui.practiceTabOpened
    || practice.status === 'processing_summary'
    || practice.status === 'processing_quiz'
    || practice.round_submitted
    || practice.practice_completed
    || (Array.isArray(practice.summary) && practice.summary.length > 0)
    || (Array.isArray(practice.quiz) && practice.quiz.length > 0)
  );
  const processing = gen.status === 'processing';
  const summaryLoading = processing && !hasSummary;
  const quizLoading = processing && hasSummary && !hasQuiz;
  const analyticsLoading = (processing && hasQuiz && !hasSpeechAnalysis) || speechRetryPending;

  setTabState(summaryTabBtn, hasSummary || gen.status === 'failed', summaryLoading);
  setTabState(quizTabBtn, hasSummary || gen.status === 'failed', quizLoading);
  setTabState(practiceTabBtn, practiceVisible, practice.status === 'processing_summary' || practice.status === 'processing_quiz');
  setTabState(analyticsTabBtn, hasQuiz || gen.status === 'failed', analyticsLoading);

  const activeTab = getActiveTab();
  const activeTabBtn = tabBtns && Array.from(tabBtns).find((btn) => btn.getAttribute('data-tab') === activeTab);
  if (activeTab !== 'transcript' && activeTabBtn && activeTabBtn.disabled) {
    setActiveTab('transcript', gen, false);
  }
}

function renderHistory() {
  const hasHistory = generations.length > 0;
  if (historySidebar) historySidebar.hidden = !hasHistory;
  if (historyToggleBtn) historyToggleBtn.hidden = !hasHistory;
  if (pageLayout) pageLayout.classList.toggle('has-history', hasHistory);

  if (!hasHistory) {
    historyList.innerHTML = '';
    historyListMobile.innerHTML = '';
    return;
  }

  const html = generations
    .map((g) => {
      const activeClass = g.id === activeGenerationId ? 'active' : '';
      return `<article class="history-item ${activeClass}">
        <div class="history-item-title">${escapeHtml(g.file_name || 'Генерация')}</div>
        <div class="history-item-row"><span class="history-status status-${g.status}">${escapeHtml(statusLabel(g.status))}</span></div>
        <div class="history-meta">${formatDateTime(g.created_at)}</div>
        <div class="history-actions">
          <button class="history-btn" data-action="open" data-id="${g.id}">Открыть</button>
          <button class="history-btn danger" data-action="delete" data-id="${g.id}">Удалить</button>
        </div>
      </article>`;
    })
    .join('');

  historyList.innerHTML = html;
  historyListMobile.innerHTML = html;
}

function openHistoryDrawer() {
  if (!historyDrawer || !historyOverlay) return;
  historyOverlay.hidden = false;
  historyDrawer.hidden = false;
  historyDrawer.classList.add('open');
  document.body.classList.add('drawer-open');
}

function closeHistoryDrawer() {
  if (!historyDrawer || !historyOverlay) return;
  historyDrawer.classList.remove('open');
  historyOverlay.hidden = true;
  historyDrawer.hidden = true;
  document.body.classList.remove('drawer-open');
}

function mergeGenerationIntoState(updatedGen) {
  if (!updatedGen || !updatedGen.id) return null;
  const enriched = enrichGeneration(updatedGen);
  const existingIndex = generations.findIndex((item) => item.id === enriched.id);
  if (existingIndex >= 0) generations[existingIndex] = enriched;
  else generations = [enriched, ...generations];
  if (requestedGenerationCache && requestedGenerationCache.id === enriched.id) {
    requestedGenerationCache = enriched;
  }
  return enriched;
}

async function refreshGenerationById(generationId) {
  if (!generationId) return null;
  const updated = await api(`/api/generations/${encodeURIComponent(generationId)}`);
  const gen = mergeGenerationIntoState(updated);
  if (!gen) return null;
  renderHistory();
  if (gen.id === activeGenerationId) {
    renderActiveGeneration();
  }
  return gen;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollGenerationUntilSettled(generationId, { timeoutMs = SPEECH_ANALYSIS_WAIT_TIMEOUT_MS, intervalMs = SPEECH_ANALYSIS_POLL_INTERVAL_MS } = {}) {
  if (!generationId) return null;
  const deadline = Date.now() + timeoutMs;
  let latest = null;

  while (Date.now() < deadline) {
    try {
      latest = await refreshGenerationById(generationId);
      if (!latest || (latest.status !== 'processing' && latest.status !== 'queued')) {
        return latest;
      }
    } catch (_e) {
      // Keep polling: the backend task may still be running.
    }
    await wait(intervalMs);
  }

  try {
    latest = await refreshGenerationById(generationId);
  } catch (_e) {
    // ignore
  }
  return latest;
}

function getSpeechAnalysisWaitMs(gen) {
  if (!gen || !gen.ui) return getGenerationAgeMs(gen);
  const retryStartedAt = Number(gen.ui.speechAnalysisRetryStartedAt || 0);
  if (Number.isFinite(retryStartedAt) && retryStartedAt > 0) {
    return Math.max(0, Date.now() - retryStartedAt);
  }
  return getGenerationAgeMs(gen);
}

function renderTranscript(gen) {
  if (!gen) {
    transcriptContainer.innerHTML = '<div class="status-message">Загрузите файл и нажмите «Обработать запись»</div>';
    updateTranscriptJumpButton();
    return;
  }
  if (gen.status === 'queued') {
    const pos = gen.queue_position || 1;
    transcriptContainer.innerHTML = `<div class="status-message"><span class="spinner-small"></span> В очереди: ${pos}-й на обработку</div>`;
    updateTranscriptJumpButton();
    return;
  }
  const transcriptLines = normalizeTranscriptLines(gen.transcript);
  const activeHighlight = getActiveTranscriptHighlight(gen);
  const transcriptHtml = transcriptLines.length
    ? transcriptLines
      .map((line, idx) => {
        const lineStartMs = Number(line.start_ms || 0);
        const shouldHighlight = activeHighlight
          && Number.isFinite(lineStartMs)
          && lineStartMs >= Number(activeHighlight.startMs)
          && lineStartMs <= Number(activeHighlight.endMs);
        return `
          <div class="transcript-line ${shouldHighlight ? 'is-highlighted' : ''}" data-line-index="${idx}" data-start-ms="${escapeHtml(line.start_ms || 0)}">
            <div class="timestamp">${formatTime(line.start_ms)}</div>
            <div class="line-text">${line.speaker ? `<span class="speaker-label">${escapeHtml(line.speaker)}:</span> ` : ''}${escapeHtml(line.text || '')}</div>
          </div>
        `;
      })
      .join('')
    : '';
  const progress = Math.max(0, Math.min(100, Math.round(Number(gen.progress_percent || 0))));
  const isProcessing = gen.status === 'processing';
  const loaderText = isProcessing
    ? (progress < 100 ? 'Обрабатываем запись' : (!gen.summary.length ? 'Генерируем конспект...' : (!gen.quiz.length ? 'Генерируем тест...' : 'Генерируем аналитику...')))
    : '';

  if (transcriptHtml) {
    transcriptContainer.innerHTML = `
      <div class="transcript-list">${transcriptHtml}</div>
      ${isProcessing ? `<div class="status-message" style="margin-top: 16px;"><span class="spinner-small"></span> ${escapeHtml(loaderText)}${progress < 100 ? ` <span class="progress-fixed">${progress}%</span>` : ''}</div>` : ''}
    `;
    requestAnimationFrame(updateTranscriptJumpButton);
    if (activeHighlight) {
      requestAnimationFrame(() => {
        const targetLine = transcriptContainer.querySelector('.transcript-line.is-highlighted');
        if (targetLine) targetLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    return;
  }
  if (isProcessing) {
    transcriptContainer.innerHTML = `<div class="status-message"><span class="spinner-small"></span> ${escapeHtml(loaderText || 'Обрабатываем запись...')}${progress < 100 && loaderText === 'Обрабатываем запись' ? ` <span class="progress-fixed">${progress}%</span>` : ''}</div>`;
    updateTranscriptJumpButton();
    return;
  }
  if (gen.status === 'failed') {
    transcriptContainer.innerHTML = `
      <div class="status-message status-message-error">
        ${escapeHtml(gen.error_message || 'Не удалось получить транскрипт.')}
        <div class="next-btn-container"><button class="next-question-btn" onclick="retryGeneration()">Попробовать снова</button></div>
      </div>
    `;
    updateTranscriptJumpButton();
    return;
  }
  transcriptContainer.innerHTML = '<div class="status-message">Транскрипт отсутствует</div>';
  updateTranscriptJumpButton();
}

function scrollToActiveTranscriptHighlight() {
  if (!transcriptContainer) return;
  const targetLine = transcriptContainer.querySelector('.transcript-line.is-highlighted');
  if (targetLine) {
    targetLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function updateTranscriptJumpButton() {
  if (!transcriptContainer || !transcriptJumpBtn) return;
  const hasOverflow = transcriptContainer.scrollHeight > transcriptContainer.clientHeight + 2;
  const distanceFromBottom = transcriptContainer.scrollHeight - transcriptContainer.scrollTop - transcriptContainer.clientHeight;
  transcriptJumpBtn.hidden = !(hasOverflow && distanceFromBottom > 20);
}

function scrollTranscriptToBottom() {
  if (!transcriptContainer) return;
  transcriptContainer.scrollTo({ top: transcriptContainer.scrollHeight, behavior: 'smooth' });
}

function nodesToMarkdown(nodes) {
  let result = '';
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || '';
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toLowerCase();
    const children = Array.from(node.childNodes);
    const renderCellMarkdown = (cellNode) => nodesToMarkdown(Array.from(cellNode.childNodes)).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|');

    if (tag === 'br') result += '\n';
    else if (tag === 'strong' || tag === 'b') result += `**${nodesToMarkdown(children).trim()}**`;
    else if (tag === 'em' || tag === 'i') result += `*${nodesToMarkdown(children).trim()}*`;
    else if (tag === 'li') result += `* ${nodesToMarkdown(children).trim()}\n`;
    else if (tag === 'ul' || tag === 'ol') result += `${nodesToMarkdown(children)}\n`;
    else if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr')).map((row) => Array.from(row.children).filter((cell) => ['TH', 'TD'].includes(cell.tagName)).map((cell) => renderCellMarkdown(cell)));
      if (rows.length) {
        const header = rows[0] || [];
        const body = rows.slice(1);
        const columnCount = Math.max(1, ...rows.map((row) => row.length));
        const normalizeRow = (row) => Array.from({ length: columnCount }, (_v, idx) => String(row[idx] || '').trim());
        const headerRow = normalizeRow(header);
        const dividerRow = Array.from({ length: columnCount }, () => '---');
        result += `| ${headerRow.join(' | ')} |\n| ${dividerRow.join(' | ')} |\n`;
        body.forEach((row) => {
          const normalized = normalizeRow(row);
          result += `| ${normalized.join(' | ')} |\n`;
        });
        result += '\n';
      }
    }
    else if (tag === 'p' || tag === 'div') {
      const inner = nodesToMarkdown(children).trim();
      if (inner) result += `${inner}\n\n`;
    } else if (tag === 'h2') {
      const inner = nodesToMarkdown(children).trim();
      result += `## ${inner}\n\n`;
    } else result += nodesToMarkdown(children);
  }
  return result;
}

function editorHtmlToSummaryData(editor) {
  const lines = nodesToMarkdown(Array.from(editor.childNodes)).split('\n');
  const sections = [];
  let title = '';
  let body = [];

  const push = () => {
    if (!title && !body.length) return;
    sections.push({ subtopic: title || `Раздел ${sections.length + 1}`, content: body.join('\n').trim() });
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      push();
      title = line.slice(3).trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  push();

  return sections.filter((s) => s.subtopic.trim() || s.content.trim());
}

function percentClass(value) {
  if (value >= 70) return 'good';
  if (value >= 40) return 'medium';
  return 'low';
}

function formatRecommendationAction(action) {
  const text = String(action || '').trim();
  if (!text) return '';

  const prefixes = ['Важно разобрать тему', 'Стоит повторить тему'];
  for (const prefix of prefixes) {
    if (text === prefix || text.startsWith(`${prefix}:`)) {
      return `<strong>${escapeHtml(prefix)}</strong>`;
    }
  }

  return escapeHtml(text);
}

function buildQuizCheckPayload(gen) {
  return {
    quiz: Array.isArray(gen.quiz) ? gen.quiz : [],
    answers: gen.quiz.map((q, idx) => {
      const qid = String(q.question_id || idx + 1);
      const qtype = q.question_type === 'open_ended' || q.question_type === 'open_question' ? 'open_question' : 'multiple_choice';
      const subtopic = q.subtopic || `Подтема ${idx + 1}`;
      const answer = gen.ui.quizAnswers[idx] || {};

      if (qtype === 'multiple_choice') {
        return {
          question_id: qid,
          question_type: 'multiple_choice',
          subtopic,
          is_correct: answer.answer === q.correct_answer
        };
      }

      return {
        question_id: qid,
        question_type: 'open_question',
        subtopic,
        question_text: q.question_text || '',
        correct_answer: q.correct_answer || '',
        student_answer: typeof answer.answer === 'string' ? answer.answer : ''
      };
    })
  };
}

function buildQuizMastery(results) {
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

function getQuizSubtopics(quiz) {
  const subtopics = new Set();
  quiz.forEach(q => {
    if (q.subtopic) subtopics.add(q.subtopic);
  });
  return Array.from(subtopics);
}

function findSummaryIndex(gen, subtopic) {
  const target = (subtopic || '').trim().toLowerCase();
  if (!gen || !target) return -1;
  return (gen.summary || []).findIndex((section) => (section.subtopic || '').trim().toLowerCase() === target);
}

function truncateLabel(text, maxLength = 30) {
  const value = text || '';
  return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}

function reviseButtonHtml(gen, subtopic) {
  if (!subtopic || findSummaryIndex(gen, subtopic) < 0) return '';
  return `
    <div class="next-btn-container">
      <button id="reviseSubtopicBtn" class="next-question-btn text-truncate" title="${escapeHtml(subtopic)}">Повторить тему «${escapeHtml(truncateLabel(subtopic))}»</button>
    </div>
  `;
}

function renderQuizAnalysisLoader() {
  quizContainer.innerHTML = `
    <div class="quiz-final-loader">
      <div class="quiz-spinner"></div>
      <div class="quiz-final-loader-title">Анализируем результаты...</div>
      <div class="quiz-final-loader-subtitle">Проверяем открытые ответы и собираем статистику по темам</div>
    </div>
  `;
}

function getTeacherQuizItemRoot(gen) {
  if (!gen) return null;
  return quizContainer.querySelector(`.quiz-item[data-question-idx="${gen.ui.quizIndex}"]`);
}

function applyTeacherSelectedAnswer(gen, answerIdx) {
  const root = getTeacherQuizItemRoot(gen);
  const q = gen && Array.isArray(gen.quiz) ? gen.quiz[gen.ui.quizIndex] : null;
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
    const nextBtn = root.querySelector('.next-question-btn');
    if (nextBtn) nextBtn.hidden = false;
  } else {
    setTimeout(() => nextQuestion(), 450);
  }
}

function getTeacherPracticeWeakSubtopics(gen) {
  if (!gen) return [];
  const ui = gen.ui || {};
  if (ui.quizCheckResult && Array.isArray(ui.quizCheckResult.recommendations) && ui.quizCheckResult.recommendations.length) {
    return ui.quizCheckResult.recommendations
      .map((item) => String(item.subtopic || '').trim())
      .filter(Boolean);
  }
  if (ui.quizCheckResult && Array.isArray(ui.quizCheckResult.mastery)) {
    return ui.quizCheckResult.mastery
      .filter((item) => Number(item.percent || 0) < 80)
      .map((item) => String(item.subtopic || '').trim())
      .filter(Boolean);
  }
  const practice = normalizePracticeState(gen.practice || {});
  if (Array.isArray(practice.weak_subtopics) && practice.weak_subtopics.length) {
    return practice.weak_subtopics;
  }
  return [];
}

function getTeacherPracticeMastery(gen) {
  if (!gen) return [];
  const ui = gen.ui || {};
  const mastery = ui.quizCheckResult && Array.isArray(ui.quizCheckResult.mastery)
    ? ui.quizCheckResult.mastery
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

function buildTeacherPracticeQuestionsPayload(gen) {
  const weakSubtopics = getTeacherPracticeWeakSubtopics(gen);
  const weakSet = new Set(weakSubtopics.map((item) => item.trim().toLowerCase()));
  const questions = [];
  const mastery = getTeacherPracticeMastery(gen);

  (Array.isArray(gen.quiz) ? gen.quiz : []).forEach((q, idx) => {
    const subtopic = String(q.subtopic || `Подтема ${idx + 1}`).trim();
    if (weakSet.size && !weakSet.has(subtopic.toLowerCase())) return;
    const qid = String(q.question_id || idx + 1);
    const answerState = gen.ui.quizAnswers[idx] || {};
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
      is_correct: open ? false : (Number.isInteger(selectedIndex) && selectedIndex === correctIndex),
      explanation: String(q.explanation || '').trim()
    });
  });

  if (!questions.length) {
    (Array.isArray(gen.quiz) ? gen.quiz : []).forEach((q, idx) => {
      const subtopic = String(q.subtopic || `Подтема ${idx + 1}`).trim();
      const qid = String(q.question_id || idx + 1);
      const answerState = gen.ui.quizAnswers[idx] || {};
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
        is_correct: open ? false : (Number.isInteger(selectedIndex) && selectedIndex === correctIndex),
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

function buildTeacherPracticeCompletionPayload(gen) {
  const practice = normalizePracticeState(gen && gen.practice ? gen.practice : {});
  const quiz = Array.isArray(practice.quiz) ? practice.quiz : [];
  const answers = quiz.map((q, idx) => {
    const qid = String(q.question_id || idx + 1);
    const qtype = q.question_type === 'open_ended' || q.question_type === 'open_question' ? 'open_question' : 'multiple_choice';
    const answerState = gen.ui.practiceQuizAnswers[idx] || {};
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

function getTeacherPracticeActionState(gen) {
  const practice = normalizePracticeState(gen && gen.practice ? gen.practice : {});
  const pending = Array.isArray(practice.pending_weak_subtopics) ? practice.pending_weak_subtopics : [];
  if (practice.practice_completed || (!pending.length && practice.round_submitted)) {
    return {
      label: 'Практика пройдена',
      disabled: true,
      kind: 'done'
    };
  }
  if (
    pending.length
    || practice.round_submitted
    || (practice.practice_round > 0 && (Array.isArray(practice.summary) && practice.summary.length || Array.isArray(practice.quiz) && practice.quiz.length))
  ) {
    return {
      label: 'Продолжить практику',
      disabled: false,
      kind: 'continue'
    };
  }
  const weakSubtopics = getTeacherPracticeWeakSubtopics(gen);
  if (weakSubtopics.length) {
    return {
      label: 'Перейти к практике',
      disabled: false,
      kind: 'start'
    };
  }
  return null;
}

function renderPracticeQuizLoader(message = 'Генерируем практику...', subtitle = 'Собираем задания на основе практического конспекта') {
  practiceContainer.innerHTML = `
    <div class="practice-layout">
      <div class="practice-summary-card">
        <h3>Практический конспект</h3>
        <div class="practice-status">Готовим практический конспект...</div>
      </div>
      <div class="practice-quiz-card" id="practiceQuizArea">
        <div class="quiz-final-loader">
          <div class="quiz-spinner"></div>
          <div class="quiz-final-loader-title">${escapeHtml(message)}</div>
          <div class="quiz-final-loader-subtitle">${escapeHtml(subtitle)}</div>
        </div>
      </div>
    </div>
  `;
}

function renderPracticeSummary(gen) {
  const practice = normalizePracticeState(gen && gen.practice ? gen.practice : {});
  if (!practiceContainer) return;

  const summary = Array.isArray(practice.summary) ? practice.summary : [];
  if (practice.status === 'idle' && !summary.length) {
    practiceContainer.innerHTML = '<div class="status-message">Практика появится после прохождения теста</div>';
    return;
  }
  if (practice.status === 'processing_summary') {
    renderPracticeQuizLoader('Готовим практику...', 'Подбираем материалы по слабым подтемам');
    return;
  }
  if (practice.status === 'stale') {
    practiceContainer.innerHTML = `
      <div class="practice-layout">
        <div class="practice-summary-card">
          <div class="practice-status">${escapeHtml(practice.stale_reason || 'Практика устарела после изменения конспекта или теста.')}</div>
        </div>
      </div>
    `;
    return;
  }
  if (practice.status === 'failed' && practice.stage === 'summary' && !summary.length) {
    practiceContainer.innerHTML = `
      <div class="practice-layout">
        <div class="practice-summary-card">
          <div class="practice-status">${escapeHtml(practice.error_message || 'Не удалось собрать практический конспект.')}</div>
          <div class="practice-action-row">
            <button class="next-question-btn" type="button" onclick="startTeacherPractice()">Попробовать еще раз</button>
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

  if (practice.round_submitted) {
    const isFinal = practice.practice_completed || !(Array.isArray(practice.pending_weak_subtopics) && practice.pending_weak_subtopics.length);
    const pendingText = Array.isArray(practice.pending_weak_subtopics) && practice.pending_weak_subtopics.length
      ? `Остались темы: ${escapeHtml(practice.pending_weak_subtopics.join(', '))}.`
      : 'Все темы уже закреплены выше порога.';
    practiceContainer.innerHTML = `
      <div class="practice-layout">
        <div class="practice-summary-card" id="practiceSummaryArea">
          <h3>Практический конспект</h3>
          ${summaryHtml}
          <div class="practice-status">${isFinal ? 'Практика завершена.' : `Раунд завершен. ${pendingText}`}</div>
          <div class="practice-action-row">
            <button class="next-question-btn" type="button" ${isFinal ? 'disabled' : 'onclick="startTeacherPractice()"'}>${isFinal ? 'Практика пройдена' : 'Продолжить практику'}</button>
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
  if (practice.practice_completed) {
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

  const quizPanelHtml = practice.status === 'processing_quiz'
    ? `
      <div class="practice-quiz-card" id="practiceQuizArea">
        <div class="quiz-final-loader">
          <div class="quiz-spinner"></div>
          <div class="quiz-final-loader-title">Генерируем практику...</div>
          <div class="quiz-final-loader-subtitle">Собираем задания на основе практического конспекта</div>
        </div>
      </div>
    `
    : (practice.status === 'failed' && practice.stage === 'quiz'
      ? `
        <div class="practice-quiz-card" id="practiceQuizArea">
          <div class="practice-status">${escapeHtml(practice.error_message || 'Не удалось сгенерировать практический тест.')}</div>
          <div class="practice-action-row">
            <button class="next-question-btn" type="button" onclick="startTeacherPracticeQuiz()">Попробовать еще раз</button>
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
}

function renderPracticeQuiz(gen) {
  const practice = normalizePracticeState(gen && gen.practice ? gen.practice : {});
  const quizArea = practiceContainer ? practiceContainer.querySelector('#practiceQuizArea') : null;
  const quiz = Array.isArray(practice.quiz) ? practice.quiz : [];
  if (gen && gen.ui && gen.ui.practiceRoundSubmitting && quizArea) {
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
    if (quizArea) quizArea.innerHTML = '<div class="status-message">Практический тест появится после генерации</div>';
    return;
  }

  const ui = gen.ui;
  if (typeof ui.practiceQuizIndex !== 'number') ui.practiceQuizIndex = 0;
  if (!Array.isArray(ui.practiceQuizAnswers)) ui.practiceQuizAnswers = [];
  if (typeof ui.practiceQuizFinished !== 'boolean') ui.practiceQuizFinished = false;

  if (ui.practiceQuizFinished || ui.practiceQuizIndex >= quiz.length) {
    if (quizArea) {
      quizArea.innerHTML = '<div class="quiz-complete">Практика завершена. Можно вернуться к конспекту или повторить задания.</div>';
    }
    setTimeout(() => renderMathInContainer(quizArea || practiceContainer), 30);
    return;
  }

  const q = quiz[ui.practiceQuizIndex];
  const answered = ui.practiceQuizAnswers[ui.practiceQuizIndex] && ui.practiceQuizAnswers[ui.practiceQuizIndex].answered;
  const open = q.question_type === 'open_ended' || q.question_type === 'open_question';
  const qid = String(q.question_id || ui.practiceQuizIndex + 1);

  let html = `<div class="quiz-item" data-question-idx="${ui.practiceQuizIndex}"><div class="quiz-question">${ui.practiceQuizIndex + 1}. ${markdownInlineToHtmlQuiz(q.question_text || '')}</div>`;

  if (open) {
    if (!answered) {
      html += '<div class="open-ended-area"><textarea id="practiceOpenAnswer" class="open-ended-input" rows="4" placeholder="Введите ваш ответ..."></textarea><button class="check-answer-btn" id="practiceCheckAnswerBtn">Проверить ответ</button></div>';
    } else {
      html += `<div class="open-ended-area"><textarea class="open-ended-input" rows="4" disabled>${escapeHtml(ui.practiceQuizAnswers[ui.practiceQuizIndex].answer || '')}</textarea></div>`;
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
        selectTeacherPracticeAnswer(gen, idx);
      });
    });
  }

  const checkBtn = document.getElementById('practiceCheckAnswerBtn');
  if (checkBtn) checkBtn.addEventListener('click', () => checkTeacherPracticeOpenEndedAnswer(gen));

  const nextBtn = targetRoot.querySelector('.next-question-btn');
  if (nextBtn) {
    nextBtn.onclick = function() {
      if (ui.practiceQuizIndex >= quiz.length) return;
      nextTeacherPracticeQuestion(gen);
    };
  }

  if (!open && answered) {
    applyTeacherPracticeSelectedAnswer(gen, ui.practiceQuizAnswers[ui.practiceQuizIndex].answer);
  }

  setTimeout(() => renderMathInContainer(targetRoot), 30);
}

function applyTeacherPracticeSelectedAnswer(gen, answerIdx) {
  const root = practiceContainer ? practiceContainer.querySelector(`#practiceQuizArea .quiz-item[data-question-idx="${gen.ui.practiceQuizIndex}"]`) : null;
  const q = gen && Array.isArray(gen.practice?.quiz) ? gen.practice.quiz[gen.ui.practiceQuizIndex] : null;
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
    const nextBtn = root.querySelector('.next-question-btn');
    if (nextBtn) nextBtn.hidden = false;
  } else {
    setTimeout(() => nextTeacherPracticeQuestion(gen), 450);
  }
}

function selectTeacherPracticeAnswer(gen, answerIdx) {
  const q = Array.isArray(gen.practice?.quiz) ? gen.practice.quiz[gen.ui.practiceQuizIndex] : null;
  if (!q) return;
  const qid = String(q.question_id || gen.ui.practiceQuizIndex + 1);
  if (gen.ui.practiceQuizAnswers[gen.ui.practiceQuizIndex] && gen.ui.practiceQuizAnswers[gen.ui.practiceQuizIndex].answered) return;
  gen.ui.practiceQuizAnswers[gen.ui.practiceQuizIndex] = { answer: answerIdx, answered: true };
  applyTeacherPracticeSelectedAnswer(gen, answerIdx);
}

function checkTeacherPracticeOpenEndedAnswer(gen) {
  const q = Array.isArray(gen.practice?.quiz) ? gen.practice.quiz[gen.ui.practiceQuizIndex] : null;
  if (!q) return;
  const input = document.getElementById('practiceOpenAnswer');
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  const qid = String(q.question_id || gen.ui.practiceQuizIndex + 1);
  gen.ui.practiceQuizAnswers[gen.ui.practiceQuizIndex] = { answer: val, answered: true };

  const root = practiceContainer ? practiceContainer.querySelector(`#practiceQuizArea .quiz-item[data-question-idx="${gen.ui.practiceQuizIndex}"]`) : null;
  if (!root) {
    renderPracticeQuiz(gen);
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
      if (gen.ui.practiceQuizIndex >= gen.practice.quiz.length) return;
      nextTeacherPracticeQuestion(gen);
    };
  }

  setTimeout(() => renderMathInContainer(root), 30);
}

function nextTeacherPracticeQuestion(gen) {
  if (!Array.isArray(gen.practice?.quiz) || gen.ui.practiceQuizIndex >= gen.practice.quiz.length) {
    submitTeacherPracticeRound(gen);
    return;
  }
  if (gen.ui.practiceQuizIndex + 1 < gen.practice.quiz.length) gen.ui.practiceQuizIndex += 1;
  else submitTeacherPracticeRound(gen);
  renderPracticeQuiz(gen);
}

async function submitTeacherPracticeRound(gen = getActiveGeneration()) {
  if (gen.ui.practiceRoundSubmitting) return;
  gen.ui.practiceRoundSubmitting = true;
  renderPracticeQuiz(gen);

  try {
    const data = await api(`/api/student/${gen.id}/practice/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTeacherPracticeCompletionPayload(gen))
    });
    gen.ui.practiceRoundSubmitting = false;
    if (data && data.practice) {
      gen.practice = normalizePracticeState(data.practice);
    }
    resetTeacherPracticeState(gen);
    renderPractice(gen);
  } catch (e) {
    gen.ui.practiceRoundSubmitting = false;
    gen.ui.practiceQuizFinished = true;
    if (practiceContainer) {
      const quizArea = practiceContainer.querySelector('#practiceQuizArea');
      if (quizArea) {
        quizArea.innerHTML = `
          <div class="practice-status">${escapeHtml(e.message || 'Не удалось сохранить результат практики.')}</div>
          <div class="practice-action-row">
            <button class="next-question-btn" type="button" onclick="submitTeacherPracticeRound()">Попробовать еще раз</button>
          </div>
        `;
      }
    }
  }
}

function resetTeacherPracticeState(gen) {
  gen.ui.practiceQuizIndex = 0;
  gen.ui.practiceQuizAnswers = [];
  gen.ui.practiceQuizFinished = false;
  gen.ui.practiceRoundSubmitting = false;
}

function openTeacherPracticeTab(gen) {
  if (!gen || !gen.ui) return;
  gen.ui.practiceTabOpened = true;
  ensurePracticeTabVisible(true);
}

async function startTeacherPractice(gen = getActiveGeneration()) {
  if (!gen) return;
  const actionState = getTeacherPracticeActionState(gen);
  if (actionState && actionState.kind === 'done') {
    openTeacherPracticeTab(gen);
    setActiveTab('practice', gen);
    renderPractice(gen);
    return;
  }
  const isContinue = actionState && actionState.kind === 'continue';
  const payload = isContinue ? {} : buildTeacherPracticeQuestionsPayload(gen);
  if (!isContinue && !payload.weak_subtopics.length) {
    showPopover('Сначала нужен результат теста с рекомендациями по подтемам.');
    return;
  }
  openTeacherPracticeTab(gen);
  setActiveTab('practice', gen);
  gen.practice = normalizePracticeState({
    ...gen.practice,
    status: 'processing_summary',
    stage: 'summary',
    error_message: '',
    stale_reason: ''
  });
  renderPractice(gen);

  try {
    const data = await api(`/api/student/${gen.id}/practice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    gen.practice = normalizePracticeState(data.practice || gen.practice);
    resetTeacherPracticeState(gen);
    renderPractice(gen);
    if (Array.isArray(gen.practice.summary) && gen.practice.summary.length && !gen.practice.round_submitted) {
      await startTeacherPracticeQuiz(gen);
    }
  } catch (e) {
    gen.practice = normalizePracticeState({
      ...gen.practice,
      status: 'failed',
      stage: 'summary',
      error_message: e.message || 'Не удалось сгенерировать практический конспект.'
    });
    renderPractice(gen);
  }
}

async function startTeacherPracticeQuiz(gen = getActiveGeneration()) {
  if (!gen) return;
  const practice = normalizePracticeState(gen.practice || {});
  if (practice.practice_completed && (!Array.isArray(practice.pending_weak_subtopics) || !practice.pending_weak_subtopics.length)) {
    openTeacherPracticeTab(gen);
    setActiveTab('practice', gen);
    renderPractice(gen);
    return;
  }
  if (practice.status === 'completed' && Array.isArray(practice.quiz) && practice.quiz.length && !practice.round_submitted) {
    openTeacherPracticeTab(gen);
    setActiveTab('practice', gen);
    renderPractice(gen);
    return;
  }
  if (!Array.isArray(practice.summary) || !practice.summary.length) {
    await startTeacherPractice(gen);
    return;
  }
  openTeacherPracticeTab(gen);
  setActiveTab('practice', gen);
  gen.practice = normalizePracticeState({
    ...practice,
    status: 'processing_quiz',
    stage: 'quiz',
    error_message: '',
    stale_reason: ''
  });
  renderPractice(gen);

  try {
    const data = await api(`/api/student/${gen.id}/practice/quiz`, {
      method: 'POST'
    });
    gen.practice = normalizePracticeState(data.practice || gen.practice);
    resetTeacherPracticeState(gen);
    renderPractice(gen);
  } catch (e) {
    gen.practice = normalizePracticeState({
      ...gen.practice,
      status: 'failed',
      stage: 'quiz',
      error_message: e.message || 'Не удалось сгенерировать практический тест.'
    });
    renderPractice(gen);
  }
}

function ensurePracticeTabVisible(enable = true) {
  if (!practiceTabBtn) return;
  practiceTabBtn.hidden = false;
  practiceTabBtn.disabled = !enable ? false : false;
  practiceTabBtn.style.opacity = '1';
}

function renderPractice(gen) {
  if (!gen) {
    practiceContainer.innerHTML = '<div class="status-message">Практика появится после прохождения теста</div>';
    return;
  }
  const practice = normalizePracticeState(gen.practice || {});
  gen.practice = practice;
  renderPracticeSummary(gen);
  if (practice.status === 'completed' && Array.isArray(practice.quiz) && practice.quiz.length && !practice.round_submitted) {
    renderPracticeQuiz(gen);
  }
}

function renderQuizCheckResults(data) {
  const gen = getActiveGeneration();
  const mastery = buildQuizMastery(Array.isArray(data.results) ? data.results : []);
  const allSubtopics = getQuizSubtopics(gen.quiz);
  const filteredMastery = mastery.filter(item => allSubtopics.includes(item.subtopic));
  const weakSubtopics = Array.isArray(data.recommendations) && data.recommendations.length
    ? data.recommendations.map((item) => String(item.subtopic || '').trim()).filter(Boolean)
    : filteredMastery.filter((item) => Number(item.percent || 0) < 80).map((item) => String(item.subtopic || '').trim()).filter(Boolean);
  const practiceAction = getTeacherPracticeActionState(gen);
  if (gen && gen.ui) {
    gen.ui.practicePromptVisible = weakSubtopics.length > 0;
  }
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

  quizContainer.innerHTML = `
    <div class="quiz-results-card">
      <h3>Результаты теста</h3>
      <div class="quiz-results-grid">${rowsHtml || '<div class="status-message">Нет данных для анализа.</div>'}</div>
      ${practiceAction ? `
        <div class="practice-action-row">
          <button class="next-question-btn" type="button" ${practiceAction.disabled ? 'disabled' : 'onclick="startTeacherPractice()"'}>${escapeHtml(practiceAction.label)}</button>
        </div>
      ` : ''}
    </div>
  `;
  setTimeout(() => renderMathInContainer(quizContainer), 30);
}

function renderQuizCheckError(message) {
  quizContainer.innerHTML = `
    <div class="quiz-results-card">
      <h3>Не удалось проверить тест</h3>
      <div class="quiz-result-recommendation">${escapeHtml(message || 'Попробуйте отправить ответы на проверку еще раз.')}</div>
      <div class="next-btn-container error-action-row"><button class="next-question-btn" onclick="retryTeacherQuizCheck()">Попробовать еще раз</button></div>
    </div>
  `;
}

async function checkTeacherQuizResults(gen, force = false) {
  if (!gen || gen.ui.quizCheckStatus === 'checking') return;
  if (!force && gen.ui.quizCheckStatus === 'done' && gen.ui.quizCheckResult) {
    renderQuiz(gen);
    return;
  }
  gen.ui.quizCheckStatus = 'checking';
  gen.ui.quizCheckResult = null;
  renderQuizAnalysisLoader();

  try {
    const data = await api(`/api/student/${gen.id}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildQuizCheckPayload(gen))
    });
    gen.ui.quizCheckStatus = 'done';
    gen.ui.quizCheckResult = data;
    renderQuiz(gen);
  } catch (e) {
    gen.ui.quizCheckStatus = 'failed';
    gen.ui.quizCheckResult = { results: [], recommendation: e.message || 'Не удалось проверить тест.' };
    renderQuizCheckError(gen.ui.quizCheckResult.recommendation);
  }
}

function buildSummaryLayoutHtml(sections, { includeToc = true, sectionClassName = 'summary-section', headingTag = 'h3', headingPrefix = 'Раздел', tocTitle = 'Оглавление', emptyMessage = 'Конспект отсутствует' } = {}) {
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

function renderSummary(gen) {
  if (!gen) {
    summaryContainer.innerHTML = '<div class="status-message">Конспект появится после обработки</div>';
    return;
  }
  if (gen.status === 'failed' && !gen.summary.length) {
    summaryContainer.innerHTML = `
      <div class="status-message status-message-error">
        ${escapeHtml(gen.error_message || 'Не удалось сгенерировать конспект.')}
        <div class="next-btn-container"><button class="next-question-btn" onclick="retryGeneration()">Попробовать снова</button></div>
      </div>
    `;
    return;
  }
  if (!gen.summary.length) {
    if (gen.status === 'queued') {
      summaryContainer.innerHTML = '<div class="status-message">Конспект появится после обработки</div>';
    } else if (gen.status === 'processing') {
      summaryContainer.innerHTML = `
        <div class="quiz-final-loader">
          <div class="quiz-spinner"></div>
          <div class="quiz-final-loader-title">Генерируем конспект...</div>
          <div class="quiz-final-loader-subtitle">Собираем итоговые разделы урока</div>
        </div>
      `;
    } else {
      summaryContainer.innerHTML = '<div class="status-message">Конспект отсутствует</div>';
    }
    return;
  }

  const ui = gen.ui;
  if (ui.isEditMode) {
    const content = gen.summary
      .map((section) => `<h2>${escapeHtml(section.subtopic || '')}</h2>${formatMarkdownToHtmlEditor(section.content || '')}`)
      .join('');
    summaryContainer.innerHTML = `
      <div class="markdown-editor-container">
        <div class="markdown-editor-toolbar">
          <button class="toolbar-btn" onclick="applyRichCommand('h2')">Заголовок H2</button>
          <button class="toolbar-btn" onclick="applyRichCommand('bold')">Жирный</button>
          <button class="toolbar-btn" onclick="applyRichCommand('italic')">Курсив</button>
          <button class="toolbar-btn" onclick="applyRichCommand('unorderedList')">Список</button>
          <button class="toolbar-btn" onclick="insertFormulaBlock()">Формула</button>
        </div>
        <div id="richSummaryEditor" class="markdown-editor rich-editor" contenteditable="true">${content}</div>
      </div>
    `;
    return;
  }

  summaryContainer.innerHTML = buildSummaryLayoutHtml(gen.summary, { includeToc: true, emptyMessage: 'Конспект отсутствует' });
  summaryContainer.querySelectorAll('.toc-item').forEach((item) => {
    item.addEventListener('click', () => {
      activeSummarySubtopic = item.getAttribute('data-subtopic') || '';
      syncSummarySelection();
      const sectionId = item.getAttribute('data-section-id');
      if (sectionId) {
        setTimeout(() => {
          document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 40);
      }
    });
  });
  syncSummarySelection();
  setTimeout(() => {
    renderMathInContainer(summaryContainer);
    highlightCodeInContainer(summaryContainer);
  }, 30);
}

function syncSummarySelection() {
  if (!summaryContainer) return;
  const active = normalizeText(activeSummarySubtopic);
  summaryContainer.querySelectorAll('.toc-item').forEach((item) => {
    const isActive = normalizeText(item.getAttribute('data-subtopic')) === active;
    item.classList.toggle('active', isActive);
  });
  summaryContainer.querySelectorAll('.summary-section').forEach((section) => {
    const isActive = normalizeText(section.getAttribute('data-subtopic')) === active;
    section.classList.toggle('is-active', isActive);
  });
}

function renderQuiz(gen) {
  if (!gen) {
    quizContainer.innerHTML = '<div class="status-message">Тест появится после обработки</div>';
    return;
  }
  if (gen.status === 'failed' && !gen.quiz.length) {
    quizContainer.innerHTML = `
      <div class="status-message status-message-error">
        ${escapeHtml(gen.error_message || 'Не удалось сгенерировать тест.')}
        <div class="next-btn-container error-action-row"><button class="next-question-btn" onclick="retryGeneration()">Попробовать снова</button></div>
      </div>
    `;
    return;
  }
  if (!gen.quiz.length) {
    if (gen.status === 'queued') {
      quizContainer.innerHTML = '<div class="status-message">Тест появится после обработки</div>';
    } else if (gen.status === 'processing') {
      quizContainer.innerHTML = `
        <div class="quiz-final-loader">
          <div class="quiz-spinner"></div>
          <div class="quiz-final-loader-title">Генерируем тест...</div>
          <div class="quiz-final-loader-subtitle">${gen.summary.length ? 'Конспект уже готов, подбираем вопросы' : 'Сначала собираем конспект урока'}</div>
        </div>
      `;
    } else {
      quizContainer.innerHTML = '<div class="status-message">Тест отсутствует</div>';
    }
    return;
  }

  const ui = gen.ui;

  if (ui.isQuizEditMode) {
    const editorHtml = gen.quiz
      .map((q, idx) => {
        const typeLabel = q.question_type === 'open_ended' ? 'Открытый' : 'С выбором';
        const opts = Array.isArray(q.options) && q.options.length ? q.options : ['Вариант 1', 'Вариант 2', 'Вариант 3', 'Вариант 4'];
        const optionsHtml = q.question_type === 'multiple_choice'
          ? opts.map((opt, optIdx) => `
              <div class="quiz-edit-option">
                <span class="quiz-edit-option-label">${optIdx + 1}.</span>
                <input class="quiz-edit-input" data-field="option" data-opt-index="${optIdx}" value="${escapeHtml(normalizeQuizText(opt || ''))}" />
              </div>`).join('') +
            `<div class="quiz-edit-correct-row">Правильный вариант:
               <select class="quiz-edit-select" data-field="correct_answer">
                 ${opts.map((_, optIdx) => `<option value="${optIdx}" ${optIdx === q.correct_answer ? 'selected' : ''}>${optIdx + 1}</option>`).join('')}
               </select>
             </div>`
          : '';

        const openPart = q.question_type === 'open_ended'
          ? `<div class="quiz-edit-answer-row"><div class="quiz-edit-label">Эталонный ответ</div><textarea class="quiz-edit-textarea" data-field="correct_answer" rows="3">${escapeHtml(normalizeQuizText(q.correct_answer || ''))}</textarea></div>`
          : '';

        return `
          <div class="quiz-edit-item" data-question-index="${idx}" data-question-type="${q.question_type}">
            <div class="quiz-edit-top"><div class="quiz-edit-number">Вопрос ${idx + 1}</div><div class="quiz-edit-type">${typeLabel}</div></div>
            <div class="quiz-edit-label">Подтема</div>
            <input class="quiz-edit-input" data-field="subtopic" value="${escapeHtml(normalizeQuizText(q.subtopic || ''))}" />
            <div class="quiz-edit-label">Текст вопроса</div>
            <textarea class="quiz-edit-textarea" data-field="question_text" rows="3">${escapeHtml(normalizeQuizText(q.question_text || ''))}</textarea>
            ${optionsHtml}
            ${openPart}
            <div class="quiz-edit-answer-row"><div class="quiz-edit-label">Объяснение</div><textarea class="quiz-edit-textarea" data-field="explanation" rows="3">${escapeHtml(normalizeQuizText(q.explanation || ''))}</textarea></div>
            <div class="quiz-edit-actions"><button class="quiz-edit-action-btn danger" type="button" onclick="removeQuizQuestion(${idx})">Удалить вопрос</button></div>
          </div>
        `;
      })
      .join('');

    quizContainer.innerHTML = `<div class="quiz-editor">${editorHtml}
      <div class="quiz-edit-global-actions">
        <button class="quiz-edit-action-btn" type="button" onclick="addQuizQuestion('multiple_choice')">+ С выбором</button>
        <button class="quiz-edit-action-btn" type="button" onclick="addQuizQuestion('open_ended')">+ Открытый</button>
      </div>
    </div>`;
    return;
  }

  const quiz = gen.quiz;
  if (ui.quizIndex >= quiz.length) {
    if (ui.quizCheckStatus === 'done' && ui.quizCheckResult) {
      renderQuizCheckResults(ui.quizCheckResult);
      return;
    }
    if (ui.quizCheckStatus === 'failed' && ui.quizCheckResult) {
      renderQuizCheckError(ui.quizCheckResult.recommendation || 'Не удалось проверить тест.');
      return;
    }
    renderQuizAnalysisLoader();
    setTimeout(() => checkTeacherQuizResults(gen), 0);
    return;
  }

  const q = quiz[ui.quizIndex];
  const answered = ui.quizAnswers[ui.quizIndex] && ui.quizAnswers[ui.quizIndex].answered;
  const open = q.question_type === 'open_ended';

  let html = `<div class="quiz-item" data-question-idx="${ui.quizIndex}"><div class="quiz-question">${ui.quizIndex + 1}. ${markdownInlineToHtmlQuiz(q.question_text || '')}</div>`;

  if (open) {
    if (!answered) {
      html += '<div class="open-ended-area"><textarea id="openAnswer" class="open-ended-input" rows="4" placeholder="Введите ваш ответ..."></textarea><button class="check-answer-btn" onclick="checkOpenEndedAnswer()">Проверить ответ</button></div>';
    } else {
      html += `<div class="open-ended-area"><textarea class="open-ended-input" rows="4" disabled>${escapeHtml(ui.quizAnswers[ui.quizIndex].answer || '')}</textarea></div>`;
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

  const nextBtn = quizContainer.querySelector('.next-question-btn');
  if (nextBtn) {
    nextBtn.onclick = function() {
      if (gen.ui.quizIndex >= gen.quiz.length) return;
      nextQuestion();
    };
  }

  if (!open && answered) {
    applyTeacherSelectedAnswer(gen, ui.quizAnswers[ui.quizIndex].answer);
  }

  setTimeout(() => renderMathInContainer(quizContainer), 30);
}

function updateTeacherQuizSelection(gen, answerIdx) {
  const root = getTeacherQuizItemRoot(gen);
  const q = gen && Array.isArray(gen.quiz) ? gen.quiz[gen.ui.quizIndex] : null;
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
    const nextBtn = root.querySelector('.next-question-btn');
    if (nextBtn) nextBtn.hidden = false;
  } else {
    setTimeout(() => nextQuestion(), 450);
  }
}

function renderAnalytics(gen) {
  if (!gen || gen.status === 'queued') {
    analyticsContainer.innerHTML = '<div class="status-message">Аналитика появится после обработки</div>';
    return;
  }
  const generationFailed = gen.status === 'failed';
  const analytics = gen.analytics && typeof gen.analytics === 'object'
    ? gen.analytics
    : buildAnalytics(gen.id, Array.isArray(gen.quiz) ? gen.quiz : []);
  const link = `${location.origin}/material/${encodeURIComponent(gen.id)}/`;
  const displayLink = link;
  const completed = Number(analytics.studentsCompleted || 0);
  const mastery = completed && Array.isArray(analytics.mastery) ? analytics.mastery : [];
  const recommendations = completed && Array.isArray(analytics.recommendations) ? analytics.recommendations.slice(0, 2) : [];
  const transcriptLines = normalizeTranscriptLines(gen.transcript);
  const speechAnalysis = buildSpeechAnalysisViewModel(gen);
  const speechAnalysisError = getSpeechAnalysisError(gen);
  const speechAnalysisWaitMs = getSpeechAnalysisWaitMs(gen);
  const speechAnalysisTimedOut = speechAnalysisWaitMs >= SPEECH_ANALYSIS_WAIT_TIMEOUT_MS;
  const speechExpanded = getSpeechAnalysisState(gen);
  const speechRetryPending = Boolean(speechExpanded && speechExpanded.speechAnalysisRetryPending);
  const hasSpeechAnalysis = Boolean(speechAnalysis);
  const hasQuiz = Array.isArray(gen.quiz) && gen.quiz.length > 0;
  const rateLimitSpeechError = /rate limit reached/i.test(speechAnalysisError);
  const masteryHtml = mastery
    .map((item) => {
      const percent = Math.max(0, Math.min(100, Number(item.percent || 0)));
      const levelClass = percentClass(percent);
      const totalLabel = item.total ? ` · ${item.correct || 0}/${item.total}` : '';
      return `
        <div class="analytics-row">
          <div class="analytics-subtopic">${escapeHtml(item.subtopic || 'Без темы')}${escapeHtml(totalLabel)}</div>
          <div class="analytics-progress-line">
            <div class="analytics-progress-fill ${levelClass}" style="width:${percent}%"></div>
          </div>
          <div class="analytics-percent">${percent}%</div>
        </div>
      `;
    })
    .join('');
  const recommendationsHtml = recommendations.length
    ? recommendations.map((item) => {
        const accent = item.priority === 'high' ? 'high' : 'medium';
        const topic = escapeHtml(item.subtopic || 'Без темы');
        const actionHtml = formatRecommendationAction(item.action || '');
        return `
          <div class="analytics-reco ${accent}">
            <div class="analytics-reco-action">${actionHtml}</div>
            <div class="analytics-reco-topic">${topic}</div>
          </div>
        `;
      }).join('')
    : '<div class="analytics-reco muted">Слабых подтем пока не найдено.</div>';
  const speechFragmentsCard = (title, fragments, sectionKey) => {
    const expanded = Boolean(speechExpanded[sectionKey]);
    return `
      <section class="speech-subcard">
        <div class="speech-subcard-title">${escapeHtml(title)}</div>
        ${renderSpeechFragmentList(fragments, gen, sectionKey, expanded, transcriptLines)}
      </section>
    `;
  };
  const speechCommentCard = (comment) => `
    <section class="speech-subcard speech-subcard-comment">
      <div class="speech-subcard-title">Комментарий</div>
      <div class="speech-subcard-text">${escapeHtml(String(comment || '').trim() || 'Комментарий отсутствует.')}</div>
    </section>
  `;
  const renderAuxAnalyticsCards = () => `
    <section class="analytics-card">
      <div class="analytics-title">Ссылка для учеников</div>
      <div class="analytics-link-wrap">
        <div class="analytics-link">${escapeHtml(displayLink)}</div>
      </div>
      <div class="analytics-link-actions">
        <button class="analytics-btn outline" type="button" onclick="openStudentLink('${escapeHtml(link)}')">Перейти</button>
        <button class="analytics-btn filled" type="button" onclick="handleCopyStudentLink(this, '${escapeHtml(link)}')">Скопировать</button>
      </div>
      <div class="analytics-meta">Завершено попыток: ${completed}</div>
    </section>

    <section class="analytics-card ${completed ? '' : 'analytics-card-disabled'}">
      <div class="analytics-title">Освоение подтем</div>
      ${masteryHtml || '<div class="status-message">Результаты появятся после первого выполнения теста учеником.</div>'}
    </section>

    <section class="analytics-card ${completed ? '' : 'analytics-card-disabled'}">
      <div class="analytics-title">Рекомендации</div>
      <div class="analytics-reco-list">${completed ? recommendationsHtml : '<div class="analytics-reco muted">Пока нет данных для рекомендаций.</div>'}</div>
    </section>
  `;
  if (speechRetryPending && !speechAnalysisTimedOut) {
    analyticsContainer.innerHTML = `
      <div class="analytics-stack">
        ${renderSpeechAnalysisLoadingCard(gen, {
          message: 'Повторно запрашиваем анализ речи преподавателя...'
        })}

        ${renderAuxAnalyticsCards()}
      </div>
    `;
    setTimeout(() => renderMathInContainer(analyticsContainer), 30);
    return;
  }

  if (!hasSpeechAnalysis) {
    if (speechRetryPending) {
      if (!speechAnalysisTimedOut) {
        analyticsContainer.innerHTML = `
          <div class="analytics-stack">
            ${renderSpeechAnalysisLoadingCard(gen, {
              message: 'Повторно запрашиваем анализ речи преподавателя...'
            })}

            ${renderAuxAnalyticsCards()}
          </div>
        `;
        setTimeout(() => renderMathInContainer(analyticsContainer), 30);
        return;
      }
    }
    if (speechAnalysisError && speechExpanded) {
      speechExpanded.speechAnalysisRetryPending = false;
    }
    const shouldRetry = generationFailed || Boolean(speechAnalysisError) || speechAnalysisTimedOut;
    const errorMessage = speechAnalysisError
      ? speechAnalysisError
      : (generationFailed
        ? (gen.error_message || 'Аналитика недоступна из-за ошибки генерации.')
        : (speechAnalysisTimedOut
        ? 'Анализ речи преподавателя не получен за 15 минут.'
        : 'Проводим анализ речи преподавателя...'));
    const shouldShowLoader = gen.status === 'processing' && hasQuiz && !speechAnalysisError && !speechAnalysisTimedOut && !generationFailed;
    analyticsContainer.innerHTML = `
      <div class="analytics-stack">
        ${ shouldShowLoader
          ? renderSpeechAnalysisLoadingCard(gen, { message: 'Проводим анализ речи преподавателя...' })
          : ((speechAnalysisError || generationFailed || speechAnalysisTimedOut)
          ? renderSpeechAnalysisErrorCard(
              rateLimitSpeechError ? 'Rate limit reached' : errorMessage,
              { retry: shouldRetry, retryDisabled: false }
            )
          : renderSpeechAnalysisLoadingCard(gen, { message: 'Проводим анализ речи преподавателя...' }))}

        ${renderAuxAnalyticsCards()}
      </div>
    `;
    setTimeout(() => renderMathInContainer(analyticsContainer), 30);
    return;
  }
  const speechGoals = speechAnalysis.structure.goals;
  if (speechExpanded) {
    speechExpanded.speechAnalysisRetryPending = false;
    speechExpanded.speechAnalysisRetryStartedAt = 0;
  }
  const speechAnalysisHtml = `
    <section class="analytics-card speech-analysis-card">
      <div class="analytics-title">Анализ речи преподавателя</div>
      <div class="speech-format-card">
        <div class="speech-format-label">Формат занятия</div>
        <div class="speech-format-value">${escapeHtml(speechAnalysis.format.label)}</div>
        <div class="speech-format-comment">${escapeHtml(speechAnalysis.format.comment)}</div>
      </div>

      <details class="speech-accordion">
        <summary>Вовлечение аудитории</summary>
        <div class="speech-accordion-body">
          <section class="speech-subcard">
            <div class="speech-subcard-title">${escapeHtml(speechAnalysis.engagement.questions.title)}</div>
            ${renderSpeechFragmentList(speechAnalysis.engagement.questions.fragments, gen, 'engagement_questions', Boolean(speechExpanded.engagement_questions), transcriptLines)}
            ${speechCommentCard(speechAnalysis.engagement.questions.comment)}
          </section>
          ${Array.isArray(speechAnalysis.engagement.answers.fragments) && speechAnalysis.engagement.answers.fragments.length
            ? `
              <section class="speech-subcard">
                <div class="speech-subcard-title">${escapeHtml(speechAnalysis.engagement.answers.title)}</div>
                ${renderSpeechFragmentList(speechAnalysis.engagement.answers.fragments, gen, 'engagement_answers', Boolean(speechExpanded.engagement_answers), transcriptLines)}
              </section>
            `
            : ''}
        </div>
      </details>

      <details class="speech-accordion">
        <summary>Структура занятия</summary>
        <div class="speech-accordion-body">
          <div class="speech-subsection-title">${escapeHtml(speechAnalysis.structure.timeline.title)}</div>
          <div class="speech-timeline">
            ${renderSpeechTimeline(speechAnalysis.structure.timeline.items)}
          </div>
          <div class="speech-subsection-title">${escapeHtml(speechGoals.title)}</div>
          ${renderSpeechGoal('Введение', speechGoals.introduction)}
          ${renderSpeechGoal('Завершение', speechGoals.ending)}
        </div>
      </details>

      <details class="speech-accordion">
        <summary>Примеры, аналогии и сторителлинг</summary>
        <div class="speech-accordion-body">
          ${renderSpeechFragmentList(speechAnalysis.explanation.fragments, gen, 'explanation', Boolean(speechExpanded.explanation), transcriptLines)}
        </div>
      </details>

      <details class="speech-accordion">
        <summary>Флаги</summary>
        <div class="speech-accordion-body">
          ${renderSpeechCheck(speechAnalysis.flags.profanity.title, speechAnalysis.flags.profanity)}
          ${speechAnalysis.flags.profanity.passed ? renderSpeechFragmentList(speechAnalysis.flags.profanity.fragments, gen, 'flags_profanity', Boolean(speechExpanded.flags_profanity), transcriptLines) : ''}
          ${renderSpeechCheck(speechAnalysis.flags.familiarity.title, speechAnalysis.flags.familiarity)}
          ${speechAnalysis.flags.familiarity.passed ? renderSpeechFragmentList(speechAnalysis.flags.familiarity.fragments, gen, 'flags_familiarity', Boolean(speechExpanded.flags_familiarity), transcriptLines) : ''}
        </div>
      </details>

      <details class="speech-accordion">
        <summary>${escapeHtml(speechAnalysis.recommendation.title || 'Рекомендация преподавателю')}</summary>
        <div class="speech-accordion-body">
          <div class="speech-subcard-text">${escapeHtml(speechAnalysis.recommendation.comment || 'Комментарий отсутствует.')}</div>
        </div>
      </details>

      <div class="speech-analysis-footer">
        <button type="button" class="speech-export-btn" data-speech-export="true">Экспорт в Excel</button>
      </div>
    </section>
  `;

  analyticsContainer.innerHTML = `
    <div class="analytics-stack">
      ${speechAnalysisHtml}

      <section class="analytics-card">
        <div class="analytics-title">Ссылка для учеников</div>
        <div class="analytics-link-wrap">
          <div class="analytics-link">${escapeHtml(displayLink)}</div>
        </div>
        <div class="analytics-link-actions">
          <button class="analytics-btn outline" type="button" onclick="openStudentLink('${escapeHtml(link)}')">Перейти</button>
          <button class="analytics-btn filled" type="button" onclick="handleCopyStudentLink(this, '${escapeHtml(link)}')">Скопировать</button>
        </div>
        <div class="analytics-meta">Завершено попыток: ${completed}</div>
      </section>

      <section class="analytics-card ${completed ? '' : 'analytics-card-disabled'}">
        <div class="analytics-title">Освоение подтем</div>
        ${masteryHtml || '<div class="status-message">Результаты появятся после первого выполнения теста учеником.</div>'}
      </section>

      <section class="analytics-card ${completed ? '' : 'analytics-card-disabled'}">
        <div class="analytics-title">Рекомендации</div>
        <div class="analytics-reco-list">${completed ? recommendationsHtml : '<div class="analytics-reco muted">Пока нет данных для рекомендаций.</div>'}</div>
      </section>
    </div>
  `;
  setTimeout(() => renderMathInContainer(analyticsContainer), 30);
}

function openSpeechTranscriptFragment(gen, startMs, endMs = null) {
  if (!gen || startMs === null || startMs === undefined || Number.isNaN(Number(startMs))) return;
  setActiveTranscriptHighlight(gen, Number(startMs), endMs === null || endMs === undefined ? Number(startMs) : Number(endMs));
  if (getActiveTab() !== 'transcript') {
    setActiveTab('transcript', gen);
  } else {
    renderTranscript(gen);
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(scrollToActiveTranscriptHighlight);
  });
}

function renderSpeechAnalysisLoadingCard(gen, { message = '' } = {}) {
  return `
    <section class="analytics-card speech-analysis-card">
      <div class="analytics-title">Анализ речи преподавателя</div>
      <div class="speech-analysis-loader">
        <div class="spinner-small"></div>
        <div class="speech-analysis-loader-text">${escapeHtml(message || 'Проводим анализ речи преподавателя...')}</div>
      </div>
    </section>
  `;
}

function renderSpeechAnalysisErrorCard(message, { retry = false, retryDisabled = false } = {}) {
  const retryButton = retry
    ? `<div class="speech-analysis-action"><button type="button" class="speech-export-btn" data-speech-retry="true" ${retryDisabled ? 'disabled aria-disabled="true"' : ''}>Попробовать снова</button></div>`
    : '';
  return `
    <section class="analytics-card speech-analysis-card">
      <div class="analytics-title">Анализ речи преподавателя</div>
      <div class="status-message status-message-error">${escapeHtml(String(message || 'Не удалось получить анализ речи преподавателя.'))}</div>
      ${retryButton}
    </section>
  `;
}

function renderActiveGeneration() {
  const gen = getActiveGeneration();
  if (gen && meUserId && gen.creator_id && gen.creator_id !== meUserId) {
    redirectToStudent(gen.id);
    return;
  }
  if (!window.matchMedia('(max-width: 1079px)').matches) {
    closeHistoryDrawer();
  }
  updateTabStates(gen);

  const canEdit = !!gen && (!gen.creator_id || gen.creator_id === meUserId);
  editSummaryBtn.disabled = !canEdit || gen.status !== 'completed' || !gen.summary.length;
  editQuizBtn.disabled = !canEdit || gen.status !== 'completed' || !gen.quiz.length;
  editSummaryBtn.textContent = gen && gen.ui.isEditMode ? 'Сохранить' : '✏️ Редактировать конспект';
  editQuizBtn.textContent = gen && gen.ui.isQuizEditMode ? 'Сохранить' : '✏️ Редактировать тест';

  renderTranscript(gen);
  renderSummary(gen);
  renderQuiz(gen);
  renderAnalytics(gen);
}

async function refresh() {
  const data = await api('/api/generations');
  generations = (data.items || []).map(enrichGeneration);
  if (requestedGenerationCache && requestedGenerationCache.creator_id === meUserId) {
    const exists = generations.some((g) => g.id === requestedGenerationCache.id);
    if (!exists) {
      generations = [enrichGeneration(requestedGenerationCache), ...generations];
    }
  }
  const aliveIds = new Set(generations.map((g) => g.id));
  Object.keys(generationUiState).forEach((id) => {
    if (!aliveIds.has(id)) delete generationUiState[id];
  });
  if (requestedGenerationId && aliveIds.has(requestedGenerationId)) {
    activeGenerationId = requestedGenerationId;
  } else if (!activeGenerationId && generations.length && !neutralMode) {
    activeGenerationId = generations[0].id;
  }
  renderHistory();
  renderActiveGeneration();
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  const delay = Math.min(1000 * (2 ** wsReconnectAttempt), 15000);
  wsReconnectAttempt += 1;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, delay);
}

function connectWs() {
  if (!meUserId) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws/generations?user_id=${encodeURIComponent(meUserId)}`);
  ws.onopen = () => {
    const wasReconnect = wsReconnectAttempt > 0;
    wsReconnectAttempt = 0;
    ws.send('ping');
    if (wasReconnect) {
      refresh().catch(() => {});
    }
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data || '{}');
      if (msg.type === 'generation_analytics_updated') {
        if (msg.generation_id) {
          refreshGenerationById(msg.generation_id).catch(() => {
            refresh().catch(() => {});
          });
        } else {
          refresh().catch(() => {});
        }
        return;
      }
      if (msg.type === 'generation_updated') refresh().catch(() => {});
    } catch (_e) {
      // ignore
    }
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch (_e) {
      // ignore
    }
  };
  ws.onclose = () => {
    ws = null;
    scheduleWsReconnect();
  };
}

function showSelectedFile(file) {
  uploadStatusDiv.innerHTML = `<div class="file-info">Файл \"${escapeHtml(file.name)}\" загружен</div>`;
  generateBtn.disabled = false;
}

function updateUploadStatus(percent) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  uploadStatusDiv.innerHTML = `<div class="file-info">Отправляем файл в обработку… ${pct}%</div>`;
}

function normalizeUploadErrorMessage(message) {
  return String(message || '') === 'File too large' ? 'Файл слишком большой' : String(message || '');
}

async function createGenerationFromFile() {
  if (!selectedFile) return;
  const fd = new FormData();
  fd.append('file', selectedFile);
  generateBtn.disabled = true;
  updateUploadStatus(0);
  setTabState(summaryTabBtn, false, false);
  setTabState(quizTabBtn, false, false);
  setTabState(analyticsTabBtn, false, false);

  try {
    const created = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          updateUploadStatus((event.loaded / event.total) * 100);
        }
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (_e) {
            reject(new Error('Некорректный ответ сервера.'));
          }
        } else {
          let detail = 'Ошибка запроса.';
          try {
            const body = JSON.parse(xhr.responseText);
            detail = body.detail || body.error || detail;
          } catch (_e) {
            // ignore
          }
          detail = normalizeUploadErrorMessage(detail);
          const error = new Error(detail);
          error.status = xhr.status;
          reject(error);
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Ошибка сети при загрузке файла.')));
      xhr.addEventListener('abort', () => reject(new Error('Загрузка файла прервана.')));
      xhr.open('POST', '/api/generations/upload');
      xhr.send(fd);
    });
    neutralMode = false;
    activeGenerationId = created.id;
    selectedFile = null;
    fileInput.value = '';
    uploadStatusDiv.innerHTML = '';
    await refresh();
  } catch (e) {
    uploadStatusDiv.innerHTML = `<div class="file-info">${escapeHtml(normalizeUploadErrorMessage(e.message || 'Не удалось запустить обработку файла.'))}</div>`;
    generateBtn.disabled = false;
  }
}

async function saveSummaryEdit() {
  const gen = getActiveGeneration();
  if (!gen) return;
  const editor = document.getElementById('richSummaryEditor');
  if (!editor) return;
  const summary = editorHtmlToSummaryData(editor);
  if (!summary.length) {
    showPopover('Добавьте хотя бы один раздел в конспекте.');
    return;
  }
  await api(`/api/generations/${gen.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary })
  });
  gen.summary = summary;
  gen.ui.isEditMode = false;
  renderSummary(gen);
}

async function saveQuizEdit() {
  const gen = getActiveGeneration();
  if (!gen) return;

  const items = Array.from(quizContainer.querySelectorAll('.quiz-edit-item'));
  if (!items.length) return;

  const quiz = items.map((item, index) => {
    const type = item.getAttribute('data-question-type');
    const question_text = (item.querySelector('[data-field="question_text"]')?.value || '').trim();
    const explanation = (item.querySelector('[data-field="explanation"]')?.value || '').trim();
    const subtopic = (item.querySelector('[data-field="subtopic"]')?.value || '').trim();

    if (type === 'multiple_choice') {
      const options = Array.from(item.querySelectorAll('[data-field="option"]')).map((n) => (n.value || '').trim());
      const correctRaw = parseInt(item.querySelector('[data-field="correct_answer"]')?.value || '0', 10);
      const correct_answer = Number.isNaN(correctRaw) ? 0 : Math.max(0, Math.min(correctRaw, Math.max(options.length - 1, 0)));
      return {
        question_id: index + 1,
        question_text,
        question_type: 'multiple_choice',
        options,
        correct_answer,
        explanation,
        subtopic
      };
    }

    return {
      question_id: index + 1,
      question_text,
      question_type: 'open_ended',
      options: null,
      correct_answer: (item.querySelector('[data-field="correct_answer"]')?.value || '').trim(),
      explanation,
      subtopic
    };
  });

  await api(`/api/generations/${gen.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quiz })
  });

  gen.quiz = quiz;
  gen.ui.isQuizEditMode = false;
  gen.ui.quizIndex = 0;
  gen.ui.quizAnswers = [];
  gen.ui.quizCheckStatus = 'idle';
  gen.ui.quizCheckResult = null;
  renderQuiz(gen);
}

window.retryGeneration = async function retryGeneration() {
  const gen = getActiveGeneration();
  if (!gen || gen.status === 'processing') return;
  const previousStatus = gen.status;
  const speechState = getSpeechAnalysisState(gen);
  if (speechState) {
    speechState.speechAnalysisRetryPending = true;
    speechState.speechAnalysisRetryStartedAt = Date.now();
  }
  gen.status = 'processing';
  gen.error_message = '';
  renderActiveGeneration();
  try {
    await api(`/api/generations/${gen.id}/retry`, { method: 'POST' });
    await pollGenerationUntilSettled(gen.id);
    if (speechState) {
      speechState.speechAnalysisRetryPending = false;
      speechState.speechAnalysisRetryStartedAt = 0;
    }
    renderActiveGeneration();
  } catch (e) {
    if (speechState) {
      speechState.speechAnalysisRetryPending = false;
      speechState.speechAnalysisRetryStartedAt = 0;
    }
    gen.status = previousStatus;
    renderActiveGeneration();
    showPopover(e.message || 'Не удалось запустить повторную генерацию.');
  }
};

window.retryTeacherQuizCheck = function retryTeacherQuizCheck() {
  const gen = getActiveGeneration();
  if (!gen) return;
  checkTeacherQuizResults(gen, true);
};

window.openSummarySubtopic = function openSummarySubtopic(subtopic) {
  const gen = getActiveGeneration();
  activeSummarySubtopic = subtopic || '';
  const idx = findSummaryIndex(gen, subtopic);
  if (summaryTabBtn) {
    summaryTabBtn.disabled = false;
    summaryTabBtn.style.opacity = '1';
  }
  const shouldRender = getActiveTab() !== 'summary';
  setActiveTab('summary', gen, shouldRender);
  if (!shouldRender) syncSummarySelection();
  if (idx >= 0) {
    setTimeout(() => {
      document.getElementById(`section-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 40);
  }
};

function bindEvents() {
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    selectedFile = f;
    showSelectedFile(f);
  });

  fileInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    selectedFile = f;
    showSelectedFile(f);
  });

  generateBtn.addEventListener('click', createGenerationFromFile);

  resetUploadBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectedFile = null;
    fileInput.value = '';
    uploadStatusDiv.innerHTML = '';
    generateBtn.disabled = true;
    neutralMode = true;
    activeGenerationId = null;
    renderHistory();
    renderActiveGeneration();
  });

  editSummaryBtn.addEventListener('click', async () => {
    const gen = getActiveGeneration();
    if (!gen || gen.status !== 'completed' || !gen.summary.length) return;
    if (gen.ui.isEditMode) {
      await saveSummaryEdit();
    } else {
      gen.ui.isEditMode = true;
      renderSummary(gen);
    }
    editSummaryBtn.textContent = gen.ui.isEditMode ? 'Сохранить' : '✏️ Редактировать конспект';
  });

  editQuizBtn.addEventListener('click', async () => {
    const gen = getActiveGeneration();
    if (!gen || gen.status !== 'completed' || !gen.quiz.length) return;
    if (gen.ui.isQuizEditMode) {
      await saveQuizEdit();
    } else {
      gen.ui.isQuizEditMode = true;
      renderQuiz(gen);
    }
    editQuizBtn.textContent = gen.ui.isQuizEditMode ? 'Сохранить' : '✏️ Редактировать тест';
  });

  const onHistoryClick = async (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');
    if (!id) return;

    if (action === 'delete') {
      await api(`/api/generations/${id}`, { method: 'DELETE' });
      if (activeGenerationId === id) activeGenerationId = null;
      await refresh();
      closeHistoryDrawer();
      return;
    }

    neutralMode = false;
    activeGenerationId = id;
    await refresh();
    closeHistoryDrawer();
  };

  historyList.addEventListener('click', onHistoryClick);
  historyListMobile.addEventListener('click', onHistoryClick);

  if (historyToggleBtn) {
    historyToggleBtn.addEventListener('click', () => {
      openHistoryDrawer();
    });
  }
  if (closeHistoryBtn) {
    closeHistoryBtn.addEventListener('click', closeHistoryDrawer);
  }
  if (historyOverlay) {
    historyOverlay.addEventListener('click', closeHistoryDrawer);
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (btn.disabled) return;
      setActiveTab(tab);
    });
  });

  if (transcriptContainer) {
    transcriptContainer.addEventListener('scroll', () => {
      if (transcriptJumpRaf) return;
      transcriptJumpRaf = window.requestAnimationFrame(() => {
        transcriptJumpRaf = 0;
        updateTranscriptJumpButton();
      });
    });
  }

  if (transcriptJumpBtn) {
    transcriptJumpBtn.addEventListener('click', scrollTranscriptToBottom);
  }

  if (analyticsContainer) {
    analyticsContainer.addEventListener('toggle', (event) => {
      const accordion = event.target;
      if (!accordion || !accordion.classList || !accordion.classList.contains('speech-accordion')) return;
    }, true);

    analyticsContainer.addEventListener('click', (event) => {
      const retryBtn = event.target.closest('[data-speech-retry="true"]');
      if (retryBtn) {
        retryGeneration();
        return;
      }

      const exportBtn = event.target.closest('[data-speech-export="true"]');
      if (exportBtn) {
        const gen = getActiveGeneration();
        exportSpeechAnalysisToExcel(gen);
        return;
      }

      const fragmentBtn = event.target.closest('[data-speech-fragment="true"]');
      if (fragmentBtn) {
        const gen = getActiveGeneration();
        const startMs = fragmentBtn.getAttribute('data-speech-start-ms');
        const endMs = fragmentBtn.getAttribute('data-speech-end-ms');
        openSpeechTranscriptFragment(gen, startMs, endMs);
        return;
      }
    });
  }
}

window.applyRichCommand = function applyRichCommand(command) {
  const editor = document.getElementById('richSummaryEditor');
  if (!editor) return;
  editor.focus();
  if (command === 'h2') {
    document.execCommand('formatBlock', false, 'h2');
    return;
  }
  if (command === 'unorderedList') {
    document.execCommand('insertUnorderedList', false, null);
    return;
  }
  document.execCommand(command, false, null);
};

window.insertFormulaBlock = function insertFormulaBlock() {
  const editor = document.getElementById('richSummaryEditor');
  if (!editor) return;
  editor.focus();
  document.execCommand('insertText', false, '\n$$\n\n$$\n');
};

window.selectAnswer = function selectAnswer(answerIdx) {
  const gen = getActiveGeneration();
  if (!gen) return;
  const ui = gen.ui;
  const q = gen.quiz[ui.quizIndex];
  if (!q) return;
  if (ui.quizAnswers[ui.quizIndex] && ui.quizAnswers[ui.quizIndex].answered) return;
  ui.quizAnswers[ui.quizIndex] = { answer: answerIdx, answered: true };
  updateTeacherQuizSelection(gen, answerIdx);
};

window.checkOpenEndedAnswer = function checkOpenEndedAnswer() {
  const gen = getActiveGeneration();
  if (!gen) return;
  const input = document.getElementById('openAnswer');
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  gen.ui.quizAnswers[gen.ui.quizIndex] = { answer: val, answered: true };

  const root = getTeacherQuizItemRoot(gen);
  const q = gen.quiz[gen.ui.quizIndex];
  if (!root || !q) {
    renderQuiz(gen);
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
      if (gen.ui.quizIndex >= gen.quiz.length) return;
      nextQuestion();
    };
  }

  setTimeout(() => renderMathInContainer(root), 30);
};

window.nextQuestion = function nextQuestion() {
  const gen = getActiveGeneration();
  if (!gen) return;
  if (gen.ui.quizIndex + 1 < gen.quiz.length) gen.ui.quizIndex += 1;
  else gen.ui.quizIndex = gen.quiz.length;
  renderQuiz(gen);
};

window.addQuizQuestion = function addQuizQuestion(type) {
  const gen = getActiveGeneration();
  if (!gen) return;
  const q = type === 'open_ended'
    ? {
        question_id: gen.quiz.length + 1,
        question_text: 'Новый открытый вопрос',
        question_type: 'open_ended',
        options: null,
        correct_answer: '',
        explanation: '',
        subtopic: ''
      }
    : {
        question_id: gen.quiz.length + 1,
        question_text: 'Новый вопрос с выбором',
        question_type: 'multiple_choice',
        options: ['Вариант 1', 'Вариант 2', 'Вариант 3', 'Вариант 4'],
        correct_answer: 0,
        explanation: '',
        subtopic: ''
      };
  gen.quiz.push(q);
  renderQuiz(gen);
};

window.removeQuizQuestion = function removeQuizQuestion(index) {
  const gen = getActiveGeneration();
  if (!gen) return;
  if (gen.quiz.length <= 1) {
    showPopover('В тесте должен остаться хотя бы один вопрос.');
    return;
  }
  gen.quiz.splice(index, 1);
  renderQuiz(gen);
};

(async function init() {
  const me = await api('/api/me');
  meUserId = me.user_id || '';
  bindEvents();
  try {
    if (requestedGenerationId) {
      requestedGenerationCache = await api(`/api/generations/${requestedGenerationId}`);
      if (requestedGenerationCache.creator_id && requestedGenerationCache.creator_id !== meUserId) {
        redirectToStudent(requestedGenerationId);
        return;
      }
      activeGenerationId = requestedGenerationId;
    }
    await refresh();
    connectWs();
  } catch (e) {
    if (requestedGenerationId && e && e.status === 404) {
      redirectToStudent(requestedGenerationId);
      return;
    }
    throw e;
  }
})();

window.addEventListener('resize', () => updateTranscriptJumpButton());

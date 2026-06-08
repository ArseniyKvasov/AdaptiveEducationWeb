# ML Service API Contract

Этот документ описывает контракт между основным приложением и отдельным ML-сервисом.
Сервис отвечает только за ML-операции: транскрибацию, мини-конспекты, итоговый конспект, генерацию теста и проверку открытых ответов.

## Общие правила

- Все endpoints, кроме `GET /health`, защищены заголовком:
  `Authorization: Bearer <ML_API_KEY>`
- Все текстовые поля и ответы сервиса — на русском языке.
- Формат данных — JSON.
- В ответах не должно быть пустых сущностей, если поле по смыслу обязательно.
- Для ошибок используется единый формат ответа.

### Формат ошибки

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Некорректный формат запроса."
  }
}
```

## Endpoints

### `GET /health`
Проверка доступности сервиса.

Request: нет

Response:
```json
{
  "ok": true,
  "service": "ml",
  "version": "1.0.0"
}
```

---

### `POST /transcribe-chunk`
Постановка задачи на транскрибацию одного аудио- или видео-чанка.

Request: `multipart/form-data`

Поля:
- `chunk_id` integer, required
- `start_ms` integer, required
- `end_ms` integer, required
- `audio_file` binary file, required

Пример:
```bash
curl -X POST "http://localhost:8000/transcribe-chunk" \
  -H "X-API-Key: your_service_api_key_here" \
  -F "chunk_id=1" \
  -F "start_ms=0" \
  -F "end_ms=15000" \
  -F "audio_file=@chunk_001.webm"
```

Response:
```json
{
  "job_id": "a1b2c3...",
  "task_type": "transcribe-chunk",
  "status": "queued"
}
```

---

### `POST /chunk-analyze`
Постановка задачи на объединённый анализ одного чанка.

Request: `application/json`

```json
{
  "chunk_id": 1,
  "start_time": "00:00",
  "end_time": "00:15",
  "transcript": [
    {
      "start_ms": 0,
      "text": "..."
    }
  ]
}
```

Поля:
- `chunk_id` integer, required
- `start_time` string, required
- `end_time` string, required
- `transcript` array, required
- каждый элемент `transcript`:
  - `start_ms` integer, required
  - `text` string, required

Response:
```json
{
  "job_id": "a1b2c3...",
  "task_type": "chunk-analyze",
  "status": "queued"
}
```

---

### `POST /mini-summary`
Совместимый endpoint для старых клиентов.

Новый основной контракт для чанков находится в `POST /chunk-analyze`.
`POST /mini-summary` может сохраняться для обратной совместимости, но новый код должен использовать общий анализ чанка.

Request: `application/json`

```json
{
  "chunk_id": 1,
  "start_time": "00:00:00",
  "end_time": "00:08:00",
  "start_ms": 0,
  "end_ms": 480000,
  "transcript": [
    {
      "start_ms": 0,
      "text": "..."
    }
  ]
}
```

Поля:
- `chunk_id` integer, required
- `start_time` string, required
- `end_time` string, required
- `start_ms` integer, required
- `end_ms` integer, required
- `transcript` array, required
- каждый элемент `transcript`:
  - `start_ms` integer, required
  - `text` string, required

Response:
```json
{
  "job_id": "a1b2c3...",
  "task_type": "mini-summary",
  "status": "queued"
}
```

---

### `POST /teacher-analysis`
Совместимый endpoint для старых клиентов.

Новый основной контракт для чанков находится в `POST /chunk-analyze`.
`POST /teacher-analysis` может сохраняться для обратной совместимости, но новый код должен использовать общий анализ чанка.

Request: `application/json`

```json
{
  "chunk_id": 1,
  "start_time": "00:00",
  "end_time": "00:15",
  "transcript": [
    {
      "start_ms": 0,
      "text": "..."
    }
  ]
}
```

Response:
```json
{
  "job_id": "a1b2c3...",
  "task_type": "teacher-analysis",
  "status": "queued"
}
```

---

### `POST /lesson-summary`
Постановка задачи на итоговый конспект.

Request: `application/json`

```json
{
  "topic_hint": "",
  "key_points": [
    "..."
  ]
}
```

Поля:
- `topic_hint` string, optional
- `key_points` array[string], required, не пустой

Response:
```json
{
  "job_id": "a1b2c3...",
  "task_type": "lesson-summary",
  "status": "queued"
}
```

---

### `POST /quiz`
Постановка задачи на генерацию теста.

Request: `application/json`

```json
{
  "summary": [
    {
      "subtopic": "Тема 1",
      "content": "..."
    }
  ],
  "mcq_count": 5,
  "open_count": 2
}
```

Поля:
- `summary` array, required
- каждый элемент `summary`:
  - `subtopic` string, required
  - `content` string, required
- `mcq_count` integer, optional, default `5`
- `open_count` integer, optional, default `2`

Response:
```json
{
  "job_id": "a1b2c3...",
  "task_type": "quiz",
  "status": "queued"
}
```

---

### `POST /practice-summary`
Постановка задачи на адаптивный практический конспект по слабым подтемам.

Request: `application/json`

```json
{
  "weak_subtopics": [
    "Тема 1",
    "Тема 2"
  ],
  "topics": [
    {
      "subtopic": "Тема 1",
      "summary_section": {
        "subtopic": "Тема 1",
        "content": "..."
      },
      "mini_summaries": [
        {
          "chunk_id": 1,
          "start_time": "00:00:00",
          "end_time": "00:08:00",
          "transcript": [
            {
              "start_ms": 0,
              "text": "..."
            }
          ]
        }
      ]
    }
  ],
  "questions": [
    {
      "question_id": "1",
      "question_type": "multiple_choice",
      "subtopic": "Тема 1",
      "question_text": "Вопрос",
      "student_answer": "Текст ответа студента",
      "correct_answer": "Текст правильного ответа",
      "is_correct": false,
      "explanation": "Пояснение"
    }
  ]
}
```

Поля:
- `weak_subtopics` array[string], required, не пустой
- `topics` array, required
- каждый элемент `topics`:
  - `subtopic` string, required
  - `summary_section` object|null, optional
  - `mini_summaries` array, optional
- каждый элемент `questions`:
  - `question_id` string, required
  - `question_type` string, required
  - `subtopic` string, required
  - `question_text` string, required
  - `student_answer` string, required
  - `correct_answer` string, required
  - `is_correct` boolean, required
  - `explanation` string, optional

Response:
```json
{
  "job_id": "a1b2c3...",
  "task_type": "practice-summary",
  "status": "queued"
}
```

---

### `POST /grade-open-answers`
Постановка задачи на проверку открытых ответов.

Request: `application/json`

```json
{
  "answers": [
    {
      "question_id": "1",
      "question_text": "Вопрос",
      "student_answer": "Ответ студента",
      "correct_answer": "Эталонный ответ"
    }
  ]
}
```

Поля:
- `answers` array, required
- каждый элемент `answers`:
  - `question_id` string, required
  - `question_text` string, required
  - `student_answer` string, required
  - `correct_answer` string, required

Response:
```json
{
  "job_id": "a1b2c3...",
  "task_type": "grade-open-answers",
  "status": "queued"
}
```

---

### `GET /tasks/{job_id}`
Проверка статуса фоновой задачи.

Response:
```json
{
  "job_id": "a1b2c3...",
  "task_type": "transcribe-chunk",
  "status": "succeeded",
  "created_at": "2026-05-10T12:00:00Z",
  "updated_at": "2026-05-10T12:00:07Z",
  "started_at": "2026-05-10T12:00:01Z",
  "finished_at": "2026-05-10T12:00:07Z",
  "result": {...},
  "error": null
}
```

Статусы:
- `queued`
- `running`
- `succeeded`
- `failed`

Для `chunk-analyze` в `result` должны возвращаться `chunk_id`, `start_time`, `end_time`, `key_points`, `teacher_questions`, `student_answers`, `examples_and_analogies`, `lesson_events`, `goals_and_summary` и `flags`.

## Рекомендуемый поток использования

1. Основное приложение режет исходный файл на чанки.
2. Для каждого чанка вызывает `POST /transcribe-chunk` и затем опрашивает `GET /tasks/{job_id}` до `succeeded`.
3. Для каждой группы транскрипта вызывает `POST /chunk-analyze` и затем опрашивает `GET /tasks/{job_id}`.
4. Из `key_points` всех chunk-analyze ответов собирает `POST /lesson-summary` и опрашивает задачу до готовности.
5. Затем вызывает `POST /quiz` и опрашивает задачу до готовности.
6. Если после теста нужны адаптивные упражнения, вызывает `POST /practice-summary` и опрашивает задачу до готовности.
7. При проверке открытых ответов вызывает `POST /grade-open-answers` и опрашивает задачу до готовности.

## Что сервис не делает

- Не хранит пользовательские материалы.
- Не управляет авторизацией.
- Не хранит историю генераций.
- Не занимается web UI.
- Не делает orchestration всего пайплайна одним запросом.

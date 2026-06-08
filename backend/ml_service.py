import asyncio
import json
import os
import time
from typing import Any, Optional

import httpx

from .text_repair import repair_latex_text, repair_latex_value


class MLServiceError(Exception):
    def __init__(self, message: str, user_message: str) -> None:
        super().__init__(message)
        self.user_message = user_message


def _fix_json_escapes(text: str) -> str:
    """Restore LaTeX escapes that Python's JSON parser turned into control characters."""
    return repair_latex_text(text)


_QUESTION_TYPE_TO_CANONICAL = {
    "rhetorical": "rhetorical",
    "риторический": "rhetorical",
    "checking_understanding": "checking_understanding",
    "проверка понимания": "checking_understanding",
    "quiz": "quiz",
    "викторина": "quiz",
    "clarifying": "clarifying",
    "уточняющий": "clarifying",
    "open_ended": "open_ended",
    "open-ended": "open_ended",
    "открытый": "open_ended",
    "factual": "factual",
    "фактический": "factual",
    "other": "other",
    "другой": "other",
}

_QUESTION_TYPE_TO_RUSSIAN = {
    "rhetorical": "риторический",
    "checking_understanding": "проверка понимания",
    "quiz": "викторина",
    "clarifying": "уточняющий",
    "open_ended": "открытый",
    "factual": "фактический",
    "other": "другой",
}


def _canonical_question_type(value: Any) -> str:
    normalized = str(value or "").strip().casefold()
    return _QUESTION_TYPE_TO_CANONICAL.get(normalized, "")


def _russian_question_type(value: Any) -> str:
    canonical = _canonical_question_type(value)
    return _QUESTION_TYPE_TO_RUSSIAN.get(canonical, "")


class MLServiceClient:
    def __init__(self, api_key: str, base_url: str = "https://ml.fastclass.ru") -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._unfinished_jobs: dict[str, str] = {}
        self._unfinished_jobs_lock = asyncio.Lock()

    def _headers(self, *, include_content_type: bool = True) -> dict[str, str]:
        if not self.api_key:
            raise MLServiceError("ML_API_KEY missing", "Не настроен ключ доступа к ML-сервису.")
        headers = {
            "X-API-Key": self.api_key,
        }
        if include_content_type:
            headers["Content-Type"] = "application/json"
        return headers

    @staticmethod
    def _http_user_message(status_code: int) -> str:
        if status_code == 429:
            return "Rate limit reached"
        if status_code in (401, 403):
            return "ML-сервис отклонил доступ. Проверьте настройки ключа."
        if status_code >= 500:
            return "ML-сервис временно недоступен. Попробуйте позже."
        return "Не удалось обработать запрос к ML-сервису."

    @staticmethod
    def _response_error_message(payload: Any) -> str:
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                message = error.get("message")
                if isinstance(message, str) and message.strip():
                    return message.strip()
        return ""

    @staticmethod
    def _task_error_message(task: Any) -> str:
        if isinstance(task, dict):
            error = task.get("error")
            if isinstance(error, dict):
                message = error.get("message")
                if isinstance(message, str) and message.strip():
                    return message.strip()
            if isinstance(error, str) and error.strip():
                return error.strip()
        return ""

    @staticmethod
    def _task_result(task: Any) -> dict[str, Any]:
        if isinstance(task, dict):
            result = task.get("result")
            if isinstance(result, dict):
                return repair_latex_value(result)
            return repair_latex_value(task)
        return {}

    @staticmethod
    def _compact_preview(value: Any, limit: int = 600) -> str:
        try:
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
        except Exception:
            text = repr(value)
        if len(text) > limit:
            return text[: limit - 3] + "..."
        return text

    async def _mark_job_started(self, request_name: str, job_id: str, request_preview: Any) -> None:
        async with self._unfinished_jobs_lock:
            self._unfinished_jobs[job_id] = request_name
            unfinished_jobs = len(self._unfinished_jobs)
            unfinished_jobs_detail = [
                {"request": req_name, "job_id": jid}
                for jid, req_name in sorted(self._unfinished_jobs.items(), key=lambda item: (item[1], item[0]))
            ]
        print(
            "[ML submit]",
            {
                "request": request_name,
                "job_id": job_id,
                "unfinished_jobs": unfinished_jobs,
                "unfinished_jobs_detail": unfinished_jobs_detail,
                "payload": request_preview,
            },
        )

    async def _mark_job_finished(self, request_name: str, job_id: str, response_preview: Any) -> None:
        async with self._unfinished_jobs_lock:
            self._unfinished_jobs.pop(job_id, None)
            unfinished_jobs = len(self._unfinished_jobs)
            unfinished_jobs_detail = [
                {"request": req_name, "job_id": jid}
                for jid, req_name in sorted(self._unfinished_jobs.items(), key=lambda item: (item[1], item[0]))
            ]
        print(
            "[ML done]",
            {
                "request": request_name,
                "job_id": job_id,
                "unfinished_jobs": unfinished_jobs,
                "unfinished_jobs_detail": unfinished_jobs_detail,
                "response": response_preview,
            },
        )

    async def _post_json(self, path: str, payload: dict[str, Any], timeout_s: int) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                resp = await client.post(url, headers=self._headers(), json=payload)
        except httpx.HTTPError as exc:
            raise MLServiceError(f"ML request failed: {exc}", "Не удалось связаться с ML-сервисом. Попробуйте позже.") from exc

        try:
            data = resp.json()
        except ValueError as exc:
            print(f"DEBUG: ML POST {path} returned invalid JSON: {resp.text[:1000]}")
            raise MLServiceError(
                f"ML returned invalid JSON ({resp.status_code}): {resp.text[:500]}",
                self._http_user_message(resp.status_code),
            ) from exc

        if resp.status_code >= 400:
            print(f"DEBUG: ML POST {path} failed: status={resp.status_code}, payload={self._compact_preview(payload)}, response={data}")
            if resp.status_code == 429:
                message = self._http_user_message(429)
            else:
                message = self._response_error_message(data) or self._http_user_message(resp.status_code)
            raise MLServiceError(f"ML HTTP error ({resp.status_code}): {data}", message)

        if not isinstance(data, dict):
            raise MLServiceError("ML response root is not an object", "Некорректный ответ от сервиса. Попробуйте позже.")
        return data

    async def _submit_task(self, path: str, payload: dict[str, Any], timeout_s: int) -> dict[str, Any]:
        task = await self._post_json(path, payload, timeout_s=timeout_s)
        job_id = task.get("job_id")
        task_type = task.get("task_type")
        status = task.get("status")
        if not isinstance(job_id, str) or not job_id.strip():
            raise MLServiceError("ML task response has no job_id", "Ошибка обработки задачи. Попробуйте позже.")
        if not isinstance(task_type, str) or not task_type.strip():
            raise MLServiceError("ML task response has no task_type", "Ошибка обработки задачи. Попробуйте позже.")
        if not isinstance(status, str) or not status.strip():
            raise MLServiceError("ML task response has no status", "Ошибка обработки задачи. Попробуйте позже.")
        await self._mark_job_started(path, job_id, self._compact_preview(payload))
        return task

    async def _submit_multipart_task(
        self,
        path: str,
        data: dict[str, Any],
        files: dict[str, tuple[str, bytes, str]],
        timeout_s: int,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                resp = await client.post(url, headers=self._headers(include_content_type=False), data=data, files=files)
        except httpx.HTTPError as exc:
            raise MLServiceError(f"ML request failed: {exc}", "Не удалось связаться с ML-сервисом. Попробуйте позже.") from exc

        try:
            payload = resp.json()
        except ValueError as exc:
            print(f"DEBUG: ML POST (multipart) {path} returned invalid JSON: {resp.text[:1000]}")
            raise MLServiceError(
                f"ML returned invalid JSON ({resp.status_code}): {resp.text[:500]}",
                self._http_user_message(resp.status_code),
            ) from exc

        if resp.status_code >= 400:
            print(f"DEBUG: ML POST (multipart) {path} failed: status={resp.status_code}, data={data}, response={payload}")
            if resp.status_code == 429:
                message = self._http_user_message(429)
            else:
                message = self._response_error_message(payload) or self._http_user_message(resp.status_code)
            raise MLServiceError(f"ML HTTP error ({resp.status_code}): {payload}", message)

        if not isinstance(payload, dict):
            raise MLServiceError("ML response root is not an object", "Некорректный ответ от сервиса. Попробуйте позже.")

        job_id = payload.get("job_id")
        task_type = payload.get("task_type")
        status = payload.get("status")
        if not isinstance(job_id, str) or not job_id.strip():
            raise MLServiceError("ML task response has no job_id", "Ошибка обработки задачи. Попробуйте позже.")
        if not isinstance(task_type, str) or not task_type.strip():
            raise MLServiceError("ML task response has no task_type", "Ошибка обработки задачи. Попробуйте позже.")
        if not isinstance(status, str) or not status.strip():
            raise MLServiceError("ML task response has no status", "Ошибка обработки задачи. Попробуйте позже.")
        file_meta: dict[str, Any] = {}
        if "audio_file" in files:
            file_name, file_bytes, mime_type = files["audio_file"]
            file_meta = {
                "file_name": file_name,
                "mime_type": mime_type,
                "bytes": len(file_bytes),
            }
        await self._mark_job_started(
            path,
            job_id,
            self._compact_preview({
                "data": data,
                "files": file_meta,
            }),
        )
        return payload

    async def _get_task(self, job_id: str, timeout_s: int) -> dict[str, Any]:
        url = f"{self.base_url}/tasks/{job_id}"
        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                resp = await client.get(url, headers=self._headers())
        except httpx.HTTPError as exc:
            raise MLServiceError(f"ML task polling failed: {exc}", "Не удалось связаться с ML-сервисом. Попробуйте позже.") from exc

        try:
            data = resp.json()
        except ValueError as exc:
            print(f"DEBUG: ML GET task {job_id} returned invalid JSON: {resp.text[:1000]}")
            raise MLServiceError(
                f"ML task returned invalid JSON ({resp.status_code}): {resp.text[:500]}",
                self._http_user_message(resp.status_code),
            ) from exc

        if resp.status_code >= 400:
            print(f"DEBUG: ML GET task {job_id} failed: status={resp.status_code}, response={data}")
            if resp.status_code == 429:
                message = self._http_user_message(429)
            else:
                message = self._response_error_message(data) or self._http_user_message(resp.status_code)
            raise MLServiceError(f"ML task HTTP error ({resp.status_code}): {data}", message)

        if not isinstance(data, dict):
            raise MLServiceError("ML task response root is not an object", "Некорректный ответ от сервиса. Попробуйте позже.")
        return data

    async def _wait_for_task(self, task: dict[str, Any], timeout_s: int, poll_interval_s: float = 2.0) -> dict[str, Any]:
        job_id = str(task.get("job_id") or "").strip()
        task_type = str(task.get("task_type") or "").strip()
        deadline = time.monotonic() + timeout_s
        current = task

        while True:
            status = str(current.get("status") or "").strip().casefold()
            if status in {"succeeded", "failed"}:
                break
            if status not in {"queued", "running"}:
                raise MLServiceError(
                    f"ML task returned unexpected status: {current}",
                    "Сервис вернул некорректный статус задачи.",
                )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise MLServiceError(
                    f"ML task timeout waiting for {task_type} ({job_id})",
                    "Превышено время ожидания ответа ML-сервиса. Попробуйте позже.",
                )
            await asyncio.sleep(min(poll_interval_s, max(0.2, remaining)))
            current = await self._get_task(job_id, timeout_s=min(30, max(1, int(remaining))))

        if str(current.get("status") or "").strip().casefold() == "failed":
            print(f"DEBUG: ML task {job_id} failed: {current}")
            error_message = self._task_error_message(current) or "Не удалось выполнить задачу в ML-сервисе."
            raise MLServiceError(
                f"ML task failed ({task_type}, {job_id}): {current}",
                error_message,
            )
        return current

    async def transcribe_chunk(
        self,
        *,
        file_name: str,
        mime_type: str,
        audio_bytes: bytes,
        chunk_id: int,
        start_ms: int,
        end_ms: int,
    ) -> list[dict[str, Any]]:
        print(f"DEBUG: transcribe_chunk: file_name={file_name}, mime_type={mime_type}, size={len(audio_bytes)}, chunk_id={chunk_id}, start_ms={start_ms}, end_ms={end_ms}")
        audio_preview = f"{len(audio_bytes)} bytes"
        task: dict[str, Any] = {}
        if os.getenv("ML_DEBUG_TRANSCRIBE_REQUESTS", "0") == "1":
            print(
                "[ML transcribe_chunk] request payload",
                {
                    "file_name": file_name,
                    "mime_type": mime_type,
                    "chunk_id": chunk_id,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "audio_file_preview": audio_preview,
                },
            )
        task = await self._submit_multipart_task(
            "/transcribe-chunk",
            data={
                "chunk_id": str(chunk_id),
                "start_ms": str(start_ms),
                "end_ms": str(end_ms),
            },
            files={
                "audio_file": (file_name, audio_bytes, mime_type),
            },
            timeout_s=600,
        )
        try:
            task = await self._wait_for_task(task, timeout_s=3600)
            data = self._task_result(task)
            transcript = data.get("transcript")
            if not isinstance(transcript, list) or not transcript:
                print(
                    "[ML transcribe_chunk] unexpected response: transcript missing or empty",
                    {
                        "file_name": file_name,
                        "chunk_id": chunk_id,
                        "start_ms": start_ms,
                        "end_ms": end_ms,
                        "response": data,
                    },
                )
                raise MLServiceError("Transcribe response has no transcript list", "Не удалось распознать текст. Попробуйте другой файл или формат.")

            normalized: list[dict[str, Any]] = []
            for item in transcript:
                if not isinstance(item, dict):
                    continue
                text = str(item.get("text") or "").strip()
                if not text:
                    continue
                try:
                    start_value = int(item.get("start_ms", 0) or 0)
                except (TypeError, ValueError):
                    start_value = 0
                item_dict = {"start_ms": start_value, "text": _fix_json_escapes(text)}
                if "speaker" in item and item["speaker"] is not None:
                    item_dict["speaker"] = str(item["speaker"]).strip()
                normalized.append(item_dict)
            if not normalized:
                print(
                    "[ML transcribe_chunk] unexpected response: transcript items have no usable text",
                    {
                        "file_name": file_name,
                        "chunk_id": chunk_id,
                        "start_ms": start_ms,
                        "end_ms": end_ms,
                        "response": data,
                        "transcript": transcript,
                    },
                )
                raise MLServiceError("Transcribe response has no valid transcript items", "Не удалось распознать текст. Попробуйте другой файл или формат.")
            return normalized
        finally:
            job_id = str(task.get("job_id") or "").strip()
            if job_id:
                await self._mark_job_finished("/transcribe-chunk", job_id, self._compact_preview(self._task_result(task)))

    async def _make_mini_summary_once(self, chunk_transcript: dict[str, Any]) -> dict[str, Any]:
        chunk_analysis = await self._make_chunk_analysis_once(chunk_transcript)
        mini_summary = self._mini_summary_from_chunk_analysis(chunk_analysis)
        if not mini_summary:
            raise MLServiceError("Mini-summary response has no key_points", "Не удалось составить конспект. Попробуйте повторить генерацию.")
        return mini_summary

    async def make_mini_summary(self, chunk_transcript: dict[str, Any]) -> dict[str, Any]:
        return await self._make_mini_summary_once(chunk_transcript)

    @staticmethod
    def _normalize_teacher_analysis_fragment(item: Any) -> dict[str, Any]:
        if not isinstance(item, dict):
            return {"start_ms": 0, "end_ms": 0, "text": ""}
        try:
            start_value = int(item.get("start_ms", 0) or 0)
        except (TypeError, ValueError):
            start_value = 0
        try:
            end_value = int(item.get("end_ms", start_value) or start_value)
        except (TypeError, ValueError):
            end_value = start_value
        if end_value < start_value:
            end_value = start_value
        fragment_type = str(item.get("type") or "").strip()
        question_type = _canonical_question_type(item.get("question_type"))
        if not question_type and str(item.get("question_type") or "").strip():
            question_type = "other"
        normalized = {
            "start_ms": start_value,
            "end_ms": end_value,
            "text": _fix_json_escapes(str(item.get("text") or "").strip()),
            **({"type": fragment_type} if fragment_type else {}),
        }
        if question_type:
            normalized["question_type"] = question_type
        return normalized

    @staticmethod
    def _localize_teacher_analysis_chunk_for_aggregate(item: Any) -> dict[str, Any]:
        if not isinstance(item, dict):
            return {}
        localized = dict(item)
        questions = localized.get("teacher_questions")
        if isinstance(questions, list):
            localized_questions: list[dict[str, Any]] = []
            for question in questions:
                if not isinstance(question, dict):
                    continue
                question_copy = dict(question)
                russian_type = _russian_question_type(question_copy.get("question_type"))
                if russian_type:
                    question_copy["question_type"] = russian_type
                elif "question_type" in question_copy:
                    question_copy.pop("question_type", None)
                localized_questions.append(question_copy)
            localized["teacher_questions"] = localized_questions
        return localized

    @staticmethod
    def _normalize_chunk_analysis_chunk(item: Any) -> dict[str, Any]:
        if not isinstance(item, dict):
            return {}

        def normalize_list(value: Any) -> list[dict[str, Any]]:
            if not isinstance(value, list):
                return []
            normalized: list[dict[str, Any]] = []
            for fragment in value:
                if not isinstance(fragment, dict):
                    continue
                text = str(fragment.get("text") or "").strip()
                if not text:
                    continue
                normalized.append(MLServiceClient._normalize_teacher_analysis_fragment(fragment))
            return normalized

        lesson_events: list[dict[str, Any]] = []
        raw_events = item.get("lesson_events")
        if isinstance(raw_events, list):
            for event in raw_events:
                if not isinstance(event, dict):
                    continue
                try:
                    start_value = int(event.get("start_ms", 0) or 0)
                except (TypeError, ValueError):
                    start_value = 0
                lesson_events.append(
                    {
                        "start_ms": start_value,
                        "title": _fix_json_escapes(str(event.get("title") or "").strip()),
                        "description": _fix_json_escapes(str(event.get("description") or "").strip()),
                    }
                )

        goals = item.get("goals_and_summary") if isinstance(item.get("goals_and_summary"), dict) else {}
        intro = goals.get("intro") if isinstance(goals, dict) and isinstance(goals.get("intro"), dict) else {}
        summary = goals.get("summary") if isinstance(goals, dict) and isinstance(goals.get("summary"), dict) else {}

        def normalize_goal(goal: Any) -> dict[str, Any]:
            if not isinstance(goal, dict):
                return {"present": False, "start_ms": None, "comment": ""}
            start_raw = goal.get("start_ms", None)
            try:
                start_value = int(start_raw) if start_raw is not None else None
            except (TypeError, ValueError):
                start_value = None
            return {
                "present": bool(goal.get("present")),
                "start_ms": start_value,
                "comment": _fix_json_escapes(str(goal.get("comment") or "").strip()),
            }

        key_points_raw = item.get("key_points")
        key_points: list[str] = []
        if isinstance(key_points_raw, list):
            key_points = [_fix_json_escapes(str(point).strip()) for point in key_points_raw if str(point).strip()]

        flags = item.get("flags") if isinstance(item.get("flags"), dict) else {}

        return {
            "chunk_id": int(item.get("chunk_id", 0) or 0),
            "start_time": str(item.get("start_time") or "").strip(),
            "end_time": str(item.get("end_time") or "").strip(),
            "key_points": key_points,
            "teacher_questions": normalize_list(item.get("teacher_questions")),
            "student_answers": normalize_list(item.get("student_answers")),
            "examples_and_analogies": normalize_list(item.get("examples_and_analogies")),
            "lesson_events": lesson_events,
            "goals_and_summary": {
                "intro": normalize_goal(intro),
                "summary": normalize_goal(summary),
            },
            "flags": {
                "profanity": normalize_list(flags.get("profanity")),
                "overly_familiar_tone": normalize_list(flags.get("overly_familiar_tone")),
            },
            "terms": [],
            "examples": [],
        }

    @staticmethod
    def _mini_summary_from_chunk_analysis(chunk_analysis: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(chunk_analysis, dict):
            return {}
        key_points_raw = chunk_analysis.get("key_points")
        key_points: list[str] = []
        if isinstance(key_points_raw, list):
            key_points = [_fix_json_escapes(str(item).strip()) for item in key_points_raw if str(item).strip()]
        if not key_points:
            return {}
        return {
            "chunk_id": chunk_analysis.get("chunk_id"),
            "start_time": chunk_analysis.get("start_time"),
            "end_time": chunk_analysis.get("end_time"),
            "key_points": key_points,
            "terms": [],
            "examples": [],
        }

    async def _make_chunk_analysis_once(self, chunk_transcript: dict[str, Any]) -> dict[str, Any]:
        task: dict[str, Any] = {}
        task = await self._submit_task("/chunk-analyze", chunk_transcript, timeout_s=600)
        try:
            task = await self._wait_for_task(task, timeout_s=3600)
            data = self._task_result(task)
            normalized = self._normalize_chunk_analysis_chunk(data)
            if not normalized or not normalized.get("key_points"):
                raise MLServiceError("Chunk analysis response is empty", "Не удалось проанализировать фрагмент. Попробуйте повторить генерацию.")
            return normalized
        finally:
            job_id = str(task.get("job_id") or "").strip()
            if job_id:
                await self._mark_job_finished("/chunk-analyze", job_id, self._compact_preview(self._task_result(task)))

    async def make_chunk_analyze(self, chunk_transcript: dict[str, Any]) -> dict[str, Any]:
        return await self._make_chunk_analysis_once(chunk_transcript)

    async def make_teacher_analysis(self, chunk_transcript: dict[str, Any]) -> dict[str, Any]:
        return await self._make_chunk_analysis_once(chunk_transcript)

    async def _make_teacher_analysis_aggregate_once(self, chunk_analyses: list[dict[str, Any]]) -> dict[str, Any]:
        payload = {
            "chunk_analyses": [self._localize_teacher_analysis_chunk_for_aggregate(chunk) for chunk in chunk_analyses],
        }
        task: dict[str, Any] = {}
        task = await self._submit_task("/teacher-analysis-aggregate", payload, timeout_s=600)
        try:
            task = await self._wait_for_task(task, timeout_s=3600)
            data = self._task_result(task)
            if not isinstance(data, dict) or not data:
                raise MLServiceError(
                    "Teacher analysis aggregate response is empty",
                    "Сервис вернул пустой агрегированный анализ речи преподавателя. Попробуйте повторить генерацию.",
                )
            return data
        finally:
            job_id = str(task.get("job_id") or "").strip()
            if job_id:
                await self._mark_job_finished("/teacher-analysis-aggregate", job_id, self._compact_preview(self._task_result(task)))

    async def make_teacher_analysis_aggregate(self, chunk_analyses: list[dict[str, Any]]) -> dict[str, Any]:
        return await self._make_teacher_analysis_aggregate_once(chunk_analyses)

    async def _make_lesson_summary_once(self, mini_summaries: list[dict[str, Any]], topic_hint: str = "") -> list[dict[str, Any]]:
        key_points: list[str] = []
        for mini_summary in mini_summaries:
            raw_points = mini_summary.get("key_points")
            if not isinstance(raw_points, list):
                continue
            for item in raw_points:
                point = str(item).strip()
                if point:
                    key_points.append(point)

        if not key_points:
            raise MLServiceError("Lesson summary request has no key_points", "Не удалось составить конспект. Попробуйте повторить генерацию.")

        payload = {
            "topic_hint": topic_hint,
            "key_points": key_points,
        }
        task: dict[str, Any] = {}
        task = await self._submit_task("/lesson-summary", payload, timeout_s=600)
        try:
            task = await self._wait_for_task(task, timeout_s=3600)
            data = self._task_result(task)
            summary = data.get("summary")
            if not isinstance(summary, list) or not summary:
                raise MLServiceError("Lesson summary response has no summary list", "Не удалось составить конспект. Попробуйте повторить генерацию.")

            normalized: list[dict[str, Any]] = []
            for idx, item in enumerate(summary):
                if not isinstance(item, dict):
                    continue
                subtopic = _fix_json_escapes(str(item.get("subtopic") or f"Раздел {idx + 1}").strip())
                content = _fix_json_escapes(str(item.get("content") or "").strip())
                if not subtopic or not content:
                    continue
                normalized.append({"subtopic": subtopic, "content": content})
            if not normalized:
                raise MLServiceError("Lesson summary response has no valid sections", "Не удалось составить конспект. Попробуйте повторить генерацию.")
            return normalized
        finally:
            job_id = str(task.get("job_id") or "").strip()
            if job_id:
                await self._mark_job_finished("/lesson-summary", job_id, self._compact_preview(self._task_result(task)))

    async def make_lesson_summary(self, mini_summaries: list[dict[str, Any]], topic_hint: str = "") -> list[dict[str, Any]]:
        return await self._make_lesson_summary_once(mini_summaries, topic_hint)

    async def make_practice_summary(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        task: dict[str, Any] = {}
        task = await self._submit_task("/practice-summary", payload, timeout_s=600)
        try:
            task = await self._wait_for_task(task, timeout_s=3600)
            data = self._task_result(task)
            summary = data.get("summary")
            if not isinstance(summary, list) or not summary:
                raise MLServiceError("Practice summary response has no summary list", "Не удалось составить практический конспект. Попробуйте повторить генерацию.")

            normalized: list[dict[str, Any]] = []
            for idx, item in enumerate(summary):
                if not isinstance(item, dict):
                    continue
                subtopic = _fix_json_escapes(str(item.get("subtopic") or f"Раздел {idx + 1}").strip())
                content = _fix_json_escapes(str(item.get("content") or "").strip())
                if not subtopic or not content:
                    continue
                normalized.append({"subtopic": subtopic, "content": content})

            if not normalized:
                raise MLServiceError("Practice summary response has no valid sections", "Не удалось составить практический конспект. Попробуйте повторить генерацию.")
            return normalized
        finally:
            job_id = str(task.get("job_id") or "").strip()
            if job_id:
                await self._mark_job_finished("/practice-summary", job_id, self._compact_preview(self._task_result(task)))

    async def make_quiz(
        self,
        summary: list[dict[str, Any]],
        *,
        mcq_count: int = 5,
        open_count: int = 2,
    ) -> list[dict[str, Any]]:
        payload = {
            "summary": summary,
            "mcq_count": mcq_count,
            "open_count": open_count,
        }
        task: dict[str, Any] = {}
        task = await self._submit_task("/quiz", payload, timeout_s=600)
        try:
            task = await self._wait_for_task(task, timeout_s=3600)
            data = self._task_result(task)
            quiz = data.get("quiz")
            if not isinstance(quiz, list) or not quiz:
                raise MLServiceError("Quiz response has no quiz list", "Не удалось создать тест. Попробуйте повторить генерацию.")

            normalized: list[dict[str, Any]] = []
            for idx, item in enumerate(quiz):
                if not isinstance(item, dict):
                    continue
                question_text = _fix_json_escapes(str(item.get("question_text") or "").strip())
                if not question_text:
                    continue
                question_type = str(item.get("question_type") or "multiple_choice").strip().casefold()
                subtopic = _fix_json_escapes(str(item.get("subtopic") or f"Раздел {idx + 1}").strip()) or f"Раздел {idx + 1}"
                explanation = _fix_json_escapes(str(item.get("explanation") or "").strip())
                question_id = item.get("question_id")
                if question_id in (None, ""):
                    question_id = idx + 1

                if question_type == "multiple_choice":
                    options = item.get("options")
                    if not isinstance(options, list) or len(options) < 2:
                        continue
                    try:
                        correct_answer = int(item.get("correct_answer"))
                    except (TypeError, ValueError):
                        continue
                    if correct_answer < 0 or correct_answer >= len(options):
                        continue
                    normalized.append(
                        {
                            "question_id": int(question_id),
                            "question_text": question_text,
                            "question_type": "multiple_choice",
                            "options": [_fix_json_escapes(str(option or "").strip()) for option in options],
                            "correct_answer": correct_answer,
                            "explanation": explanation,
                            "subtopic": subtopic,
                        }
                    )
                    continue

                if question_type in {"open_ended", "open_question"}:
                    correct_answer = _fix_json_escapes(str(item.get("correct_answer") or "").strip())
                    if not correct_answer:
                        continue
                    normalized.append(
                        {
                            "question_id": int(question_id),
                            "question_text": question_text,
                            "question_type": "open_ended",
                            "options": None,
                            "correct_answer": correct_answer,
                            "explanation": explanation,
                            "subtopic": subtopic,
                        }
                    )

            if not normalized:
                raise MLServiceError("Quiz response has no valid question items", "Не удалось создать тест. Попробуйте повторить генерацию.")
            return normalized
        finally:
            job_id = str(task.get("job_id") or "").strip()
            if job_id:
                await self._mark_job_finished("/quiz", job_id, self._compact_preview(self._task_result(task)))

    async def grade_open_answers(self, answers: list[dict[str, Any]]) -> dict[str, Any]:
        payload = {
            "answers": answers,
        }
        task: dict[str, Any] = {}
        task = await self._submit_task("/grade-open-answers", payload, timeout_s=600)
        try:
            task = await self._wait_for_task(task, timeout_s=3600)
            data = self._task_result(task)
            scores = data.get("scores")
            if not isinstance(scores, list):
                raise MLServiceError("Open answer grading response has no scores list", "Не удалось проверить открытые ответы.")

            normalized_scores: list[dict[str, Any]] = []
            for item in scores:
                if not isinstance(item, dict):
                    continue
                question_id = str(item.get("question_id") or "").strip()
                if not question_id:
                    continue
                try:
                    score = 1 if int(item.get("score", 0) or 0) else 0
                except (TypeError, ValueError):
                    score = 0
                normalized_scores.append({"question_id": question_id, "score": score})

            if not normalized_scores:
                raise MLServiceError("Open answer grading response has no valid scores", "Не удалось проверить открытые ответы.")

            return {"scores": normalized_scores}
        finally:
            job_id = str(task.get("job_id") or "").strip()
            if job_id:
                await self._mark_job_finished("/grade-open-answers", job_id, self._compact_preview(self._task_result(task)))

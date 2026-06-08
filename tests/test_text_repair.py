from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from adaptlearning.backend import main
from adaptlearning.backend.text_repair import repair_latex_text, repair_latex_value


class LatexRepairHelperTests(unittest.TestCase):
    def test_repair_latex_text_preserves_math_and_paragraph_breaks(self) -> None:
        broken_beta = "\beta"
        broken_nabla = "\nabla"
        broken_frac = "\frac"

        raw = (
            "Первая строка\\nВторая строка. "
            "\\(\\displaystyle\\int_{c}^{d}\\!\\!\\int_{\\alpha(y)}^{"
            f"{broken_nabla}(y)}} "
            f"{broken_frac}{{1}}{{2}} + {broken_beta}\\,dx\\,dy\\)"
        )

        repaired = repair_latex_text(raw)

        self.assertIn("Первая строка\nВторая строка.", repaired)
        self.assertIn("\\alpha(y)", repaired)
        self.assertIn("\\nabla(y)", repaired)
        self.assertIn("\\frac{1}{2}", repaired)
        self.assertIn("\\beta\\,dx\\,dy", repaired)
        self.assertNotIn("\x08", repaired)
        self.assertNotIn("\x0c", repaired)
        self.assertNotIn("\nabla", repaired)

    def test_repair_latex_value_walks_nested_structures(self) -> None:
        payload = {
            "summary": [
                {"content": "Формула: \\(x = " + "\beta" + " + " + "\frac" + "{1}{2}\\)"}
            ],
            "quiz": [{"question_text": "Найдите \\(" + "\nabla" + " f(x)\\)"}],
        }

        repaired = repair_latex_value(payload)

        self.assertEqual(repaired["summary"][0]["content"].count("\\beta"), 1)
        self.assertIn("\\frac{1}{2}", repaired["summary"][0]["content"])
        self.assertIn("\\nabla", repaired["quiz"][0]["question_text"])


class StudentApiRepairTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_db_path = main.DB_PATH
        self._tmpdir = tempfile.TemporaryDirectory()
        main.DB_PATH = Path(self._tmpdir.name) / "app.db"
        main.init_db()

    def tearDown(self) -> None:
        main.DB_PATH = self._old_db_path
        self._tmpdir.cleanup()

    def _seed_generation(
        self,
        status: str = "completed",
        summary: list[dict[str, object]] | None = None,
        quiz: list[dict[str, object]] | None = None,
        practice: dict[str, object] | None = None,
    ) -> str:
        generation_id = "gen_test_latex"
        user_id = "user_test_latex"
        summary = summary if summary is not None else [
            {
                "subtopic": "Тема 1",
                "content": "Формула: \\(\\displaystyle\\int_{c}^{d}\\!\\!\\int_{\\alpha(y)}^"
                + "\nabla(y)} "
                + "\frac{1}{2} + "
                + "\beta"
                + "\\,dx\\,dy\\)"
            }
        ]
        quiz = quiz if quiz is not None else [
            {
                "question_id": 1,
                "question_text": "Что означает \\(" + "\frac" + "{1}{2}\\)?",
                "question_type": "multiple_choice",
                "options": ["A", "B", "C"],
                "correct_answer": 1,
                "explanation": "Смотрите на \\(" + "\beta" + " и " + "\nabla" + " \\).",
                "subtopic": "Тема 1",
            }
        ]

        conn = sqlite3.connect(main.DB_PATH)
        conn.execute("INSERT INTO users (id, created_at) VALUES (?, ?)", (user_id, main.now_iso()))
        conn.execute(
            """
            INSERT INTO generations
            (id, user_id, creator_id, file_name, status, progress_percent, created_at, transcript_json, mini_summary_json, summary_json, quiz_json, practice_json, analytics_json, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                generation_id,
                user_id,
                user_id,
                "demo.mp4",
                status,
                100,
                main.now_iso(),
                "[]",
                "[]",
                json.dumps(summary, ensure_ascii=False),
                json.dumps(quiz, ensure_ascii=False),
                json.dumps(practice if practice is not None else {}, ensure_ascii=False),
                "{}",
                "",
            ),
        )
        conn.commit()
        conn.close()
        return generation_id

    def test_api_student_repairs_legacy_latex_escapes(self) -> None:
        generation_id = self._seed_generation()

        with TestClient(main.app) as client:
            response = client.get(f"/api/student/{generation_id}")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        summary_content = payload["summary"][0]["content"]
        question_text = payload["quiz"][0]["question_text"]
        explanation = payload["quiz"][0]["explanation"]

        self.assertIn("\\beta", summary_content)
        self.assertIn("\\nabla", summary_content)
        self.assertIn("\\frac{1}{2}", summary_content)
        self.assertNotIn("\x08", summary_content)
        self.assertNotIn("\x0c", summary_content)

        self.assertIn("\\frac{1}{2}", question_text)
        self.assertIn("\\beta", explanation)
        self.assertIn("\\nabla", explanation)

    def test_student_quiz_check_is_available_before_analytics_finishes(self) -> None:
        generation_id = self._seed_generation(status="processing")

        with TestClient(main.app) as client:
            page_response = client.get(f"/api/student/{generation_id}")
            check_response = client.post(
                f"/api/student/{generation_id}/check",
                json={
                    "answers": [
                        {
                            "question_id": "1",
                            "question_type": "multiple_choice",
                            "subtopic": "Тема 1",
                            "is_correct": True,
                        }
                    ]
                },
            )

        self.assertEqual(page_response.status_code, 200)
        self.assertEqual(check_response.status_code, 200)
        payload = check_response.json()
        self.assertEqual(payload["results"][0]["score"], 1)
        self.assertEqual(payload["recommendation"], "Отлично: все подтемы теста освоены.")

    def test_student_quiz_check_can_use_payload_quiz_before_db_persisted(self) -> None:
        generation_id = self._seed_generation(
            status="processing",
            summary=[],
            quiz=[],
        )
        payload_quiz = [
            {
                "question_id": 1,
                "question_text": "Что означает 1/2?",
                "question_type": "multiple_choice",
                "options": ["A", "B", "C"],
                "correct_answer": 1,
                "explanation": "Верный ответ B.",
                "subtopic": "Тема 1",
            }
        ]

        with TestClient(main.app) as client:
            check_response = client.post(
                f"/api/student/{generation_id}/check",
                json={
                    "quiz": payload_quiz,
                    "answers": [
                        {
                            "question_id": "1",
                            "question_type": "multiple_choice",
                            "subtopic": "Тема 1",
                            "is_correct": True,
                        }
                    ],
                },
            )

        self.assertEqual(check_response.status_code, 200)
        payload = check_response.json()
        self.assertEqual(payload["results"][0]["score"], 1)
        persisted = main.get_generation(generation_id)
        self.assertTrue(isinstance(persisted.get("quiz"), list) and len(persisted.get("quiz", [])) == 1)

    def test_student_practice_can_start_before_generation_finishes(self) -> None:
        generation_id = self._seed_generation(status="processing")

        async def fake_make_practice_summary(self, _practice_context):
            return [
                {
                    "subtopic": "Тема 1",
                    "content": "Практический конспект.",
                }
            ]

        with patch.object(main, "ML_API_KEY", "test-key"), patch.object(main.MLServiceClient, "make_practice_summary", fake_make_practice_summary):
            with TestClient(main.app) as client:
                response = client.post(
                    f"/api/student/{generation_id}/practice",
                    json={
                        "weak_subtopics": ["Тема 1"],
                        "questions": [
                            {
                                "question_id": "1",
                                "question_type": "multiple_choice",
                                "subtopic": "Тема 1",
                                "question_text": "Вопрос",
                                "correct_answer": "A",
                                "student_answer": "A",
                                "is_correct": True,
                                "explanation": "Объяснение",
                            }
                        ],
                        "mastery": {"Тема 1": 40},
                    },
                )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["practice"]["status"], "summary_ready")
        self.assertEqual(payload["practice"]["summary"][0]["subtopic"], "Тема 1")

    def test_student_practice_quiz_can_start_before_generation_finishes(self) -> None:
        practice_state = {
            "status": "summary_ready",
            "stage": "summary",
            "summary": [
                {
                    "subtopic": "Тема 1",
                    "content": "Практический конспект.",
                }
            ],
            "quiz": [],
            "weak_subtopics": ["Тема 1"],
            "current_weak_subtopics": ["Тема 1"],
            "pending_weak_subtopics": [],
        }
        generation_id = self._seed_generation(status="processing", practice=practice_state)

        async def fake_make_quiz(self, _practice_summary):
            return [
                {
                    "question_id": 1,
                    "question_text": "Практический вопрос",
                    "question_type": "multiple_choice",
                    "options": ["A", "B"],
                    "correct_answer": 1,
                    "explanation": "Объяснение",
                    "subtopic": "Тема 1",
                }
            ]

        with patch.object(main, "ML_API_KEY", "test-key"), patch.object(main.MLServiceClient, "make_quiz", fake_make_quiz):
            with TestClient(main.app) as client:
                response = client.post(f"/api/student/{generation_id}/practice/quiz")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["practice"]["status"], "completed")
        self.assertEqual(payload["practice"]["quiz"][0]["question_text"], "Практический вопрос")

    def test_student_practice_complete_can_save_before_generation_finishes(self) -> None:
        practice_state = {
            "status": "completed",
            "stage": "quiz",
            "summary": [
                {
                    "subtopic": "Тема 1",
                    "content": "Практический конспект.",
                }
            ],
            "quiz": [
                {
                    "question_id": 1,
                    "question_text": "Практический вопрос",
                    "question_type": "multiple_choice",
                    "options": ["A", "B"],
                    "correct_answer": 1,
                    "explanation": "Объяснение",
                    "subtopic": "Тема 1",
                }
            ],
            "weak_subtopics": ["Тема 1"],
            "current_weak_subtopics": ["Тема 1"],
            "pending_weak_subtopics": [],
            "mastery": {},
            "mastery_order": [],
        }
        generation_id = self._seed_generation(status="processing", practice=practice_state)

        with TestClient(main.app) as client:
            response = client.post(
                f"/api/student/{generation_id}/practice/complete",
                json={
                    "answers": [
                        {
                            "question_id": "1",
                            "question_type": "multiple_choice",
                            "subtopic": "Тема 1",
                            "is_correct": True,
                        }
                    ]
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["results"][0]["score"], 1)
        self.assertTrue(payload["practice"]["practice_completed"])


if __name__ == "__main__":
    unittest.main()

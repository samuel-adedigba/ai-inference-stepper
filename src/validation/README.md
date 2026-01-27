# ✅ Validation & Schemas

AI models are non-deterministic; they can sometimes return malformed JSON or skip required fields. This module ensures that every report returned by the **Inference Stepper** follows a strict, predictable format.

## 🎯 Purpose

- **Reliability**: Guarantees the API always returns data that matches the frontend's expectations.
- **Data Integrity**: Uses **Zod** to validate types and string lengths.
- **Fail-fast**: If an AI returns bad data, we catch it early and try a different provider.

## 📋 The Report Schema

Every report must contain:

- `title`: A concise summary of the change.
- `summary`: A detailed explanation.
- `changes`: A list of specific file/logic modifications.
- `rationale`: Why the change was made.
- `impact_and_tests`: What was affected and how it was verified.
- `next_steps`: Future tasks or related work.
- `tags`: Keywords for categorization.

## 🛠️ Usage

This module is used by every provider adapter. After the AI returns a string, the adapter calls `parseAndValidateReport()` to transform that string into a validated object.

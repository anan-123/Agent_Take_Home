## Scenario

It is Monday at 8am at a multi-disciplinary pediatric therapy practice supporting speech-language pathology, occupational therapy, and physical therapy. The shared inbox accumulated items over the weekend from pediatrician fax referrals, parent voicemails, parent portal messages, and emails. Built an AI agent prototype that turns the messy batch into a sorted, human-reviewable action plan.


## How To Run
Add your anthropic key to the environment before running the code.

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

The commands also work with no flags and default to the paths above. Reviewers may run the same commands against similar hidden synthetic input. Do not hardcode input, output, or trace paths.
I have run with no flags for testing.

## Stack and runtime
Language: TypeScript
Runtime: Node.js
External LLM: Anthropic Claude (Haiku 4.5 used for extraction/classification as its faster than opus but opus is better quality responses)
Tooling model: Deterministic orchestration layer with LLM-assisted extraction
API usage: fetch calls to Anthropic Messages API
No external frameworks (kept minimal for auditability and grading clarity)
Runtime: 10000 - 15000ms for haiku and 20970ms for opus.


## Architecture
The current architecture is a hybrid system combining LLM-assisted extraction with deterministic rule-based routing. The next step is to extend to a fully LLM-planned, iterative agent architecture with feedback-driven tool execution.

Each inbox item is first processed through an extraction and classification step using Claude Haiku, which converts unstructured text into structured fields including child name, date of birth or age, discipline, payer, clinical concern, and member ID. The model also produces a classification label (e.g., new_referral, scheduling, safeguarding, billing_question, clinical_question, complaint) and a safety flag. A fallback rule-based extractor is used when the LLM fails or returns invalid output.

After extraction, the system uses deterministic routing logic to dispatch each item to a dedicated handler based on its classification. These handlers execute predefined sequences of tool calls such as search_patient, verify_insurance, lookup_policy, find_slots, create_task, draft_message, and escalate. Safeguarding cases bypass normal routing and immediately trigger escalation with P0 severity.

Finally, all tool calls are executed within a per-item context using withItemContext, enabling full traceability through getToolCallsForItem. The system produces structured outputs that include urgency calibration (P0–P3), human-review requirements, task assignments, and audit logs of all tool interactions.

## Failure modes and production eval

The current system handles failures in the Claude-based extraction step through a fallback mechanism to rule-based classification and extraction. However, it does not robustly handle failures in downstream tool execution (e.g., search_patient, verify_insurance, find_slots, or create_task). If a tool call fails, the workflow may silently degrade, resulting in incomplete or partially executed processes without recovery or compensation. To mitigate this, retry logic with exponential backoff can be introduced for transient tool failures, along with explicit error handling and structured failure states returned in the ItemOutput. In addition, adding idempotency keys for tool calls and capturing partial execution state would improve resilience against duplicate or inconsistent operations. For production evaluation, system reliability should be measured not only in terms of classification accuracy, but also tool success rate, retry effectiveness, and end-to-end workflow completion rate under simulated failure conditions and high-load scenarios.
## What I chose not to build, and why
This system deliberately avoids building a fully autonomous LLM agent that plans and executes tool chains end-to-end. Instead, Claude is restricted to structured extraction and classification, while deterministic application logic handles routing, tool selection, and workflow execution. The system also does not include automated patient-facing messaging, self-healing or retry orchestration, cross-item memory, or fully model-driven urgency scoring, as these introduce unpredictable behavior, reduce auditability, and increase risk in clinical contexts where safety and correctness must be strictly controlled.

A planner-based architecture was intentionally avoided because it introduces non-deterministic execution paths for the same input, making it harder to guarantee consistent handling of critical cases such as safeguarding escalation. It also complicates debugging and production tracing, since failures would no longer map to a specific handler function but instead emerge from multi-step LLM-driven decision sequences. This becomes particularly risky when tool calls have side effects—such as creating tasks, drafting messages, or checking insurance—where incorrect planning can lead to partial or unintended state changes that are difficult to reliably roll back.
## What I would do with another 4 hours
1. Currently, Claude is used primarily for analysis and classification to determine which tools to call, while the overall workflow and routing logic is handled through rule-based functions. A true agent architecture would shift this responsibility to a planner that dynamically selects and sequences tool calls, rather than relying on predefined handlers. I did not have sufficient time to fully debug this planner-based approach, especially the map to handle classification. The next step would be to build a more robust agent system, potentially including an iterative execution loop where the agent can reflect on tool outputs and correct or refine its actions based on feedback.
2. For PHI and privacy concerns, the goal was to anonymize sensitive information before sending data to the LLM, including removing names, emails, and other identifiers. These would be replaced with placeholders such as <PATIENT> or structured IDs to ensure compliance and reduce data exposure risk. This was partially implemented, but not fully completed; as a result, the current version still relies on earlier code where full redaction and tokenization were not fully enforced.
3. The system should be evaluated on larger and more diverse datasets to assess scalability, robustness, and consistency under load. This includes testing edge cases, high-volume inbox scenarios, and more complex multi-intent messages to ensure the routing logic and tool execution remain stable at scale.
4. Additional next steps include improving observability and evaluation tooling (e.g., structured logs for tool sequences, failure tracing, and per-classification metrics), as well as introducing stronger guardrails for ambiguous cases where classification confidence is low, to ensure safer fallback behavior and more reliable human escalation.
5. I would revise the agent architecture if given more time and spend more time system designing.




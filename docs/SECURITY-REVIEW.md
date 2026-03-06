# Security Review: Prompt Injection Mitigation Strategy

> **Date**: 2026-03-05
> **Status**: Pre-implementation review
> **Related**: [CONTENT-PIPES.md](./CONTENT-PIPES.md), [SECURITY.md](./SECURITY.md), [SECURITY-ARCHITECTURE.md](../../docs/SECURITY-ARCHITECTURE.md)

---

## Executive Summary

CONTENT-PIPES.md is a strong architecture that correctly implements the Dual LLM pattern — the most applicable of six proven design patterns for CamBot's threat model. Combined with CamBot's existing 17-module security stack (~1800 LOC in cambot-core), we have a far better starting point than most LLM agent systems.

However, the research is unambiguous: **no single defense works.** The joint OpenAI/Anthropic/DeepMind paper "The Attacker Moves Second" (Oct 2025, 14 authors) tested 12 published defenses and bypassed all of them with >90% success under adaptive attack conditions. The goal is defense-in-depth that makes attacks expensive, detectable, and limited in blast radius.

**Bottom line: Build the architecture (CONTENT-PIPES), adopt open-source classifiers (Prompt Guard 2, LlamaFirewall), don't buy SaaS.**

---

## Part 1: CONTENT-PIPES.md Critique

### What's Right

| Aspect | Assessment |
|---|---|
| Dual LLM pattern (Haiku summarizer, zero tools) | Textbook correct per Willison/2025 paper |
| Bus unification as prerequisite | Architecturally sound — security bypassed by a different code path is theater |
| Gmail MCP adapter (closing bypass) | Critical insight — most architectures miss agent-initiated read paths |
| Structured JSON output from summarizer | Prevents quarantined LLM from injecting envelope structure |
| Honest residual risk acknowledgment | Accurate — matches academic consensus |
| Phased implementation plan | Practical, well-scoped, minimal file changes |

### 5 Gaps to Address

#### Gap 1: No ML Pre-Classifier

The pipeline is `regex -> Haiku` for every untrusted message. This means ~$0.001 + 1-2s latency on every email, even the ~95% that are benign.

**Fix:** Add Meta Prompt Guard 2 (86M params, ~18ms GPU / ~300ms CPU) as a pre-filter. Clean messages skip Haiku entirely. The 22M variant cuts compute by 75% further. In independent benchmarks, Prompt Guard 2 detected 97.5% of attacks. CamBot's existing regex detector catches known patterns; Prompt Guard catches novel ones the regex misses.

**Where it fits in the pipeline:**
```
regex detector (existing) -> Prompt Guard 2 classifier (new) -> Haiku summarizer (existing design)
                                  |
                          clean? skip Haiku
                          flagged? proceed to Haiku
                          critical? block immediately
```

#### Gap 2: No Post-Action Auditing

The document focuses entirely on *input* sanitization but says nothing about validating what the agent *does after* seeing content. OWASP's cheat sheet explicitly requires tool-call validation and anomaly detection.

**Fix:** Add a post-tool-call auditor. Meta's LlamaFirewall includes "Agent Alignment Checks" — a chain-of-thought auditor that detects when an agent's reasoning has been corrupted. This reduced attack success from 17.6% to 1.7% on the AgentDojo benchmark.

#### Gap 3: `<untrusted-content>` Markers Are Convention, Not Enforcement

Research confirms LLMs can be convinced to ignore safety markers. The LLM-as-a-Judge vulnerability paper (arXiv:2505.13348) demonstrates this systematically.

**Fix:** Reduce the agent's tool permissions when operating on raw content. CamBot's circuit breaker already supports tool restriction by state — extend it to apply `restrict` state during raw content processing (block `send_gmail_message`, `schedule_task`, `register_group` while `<untrusted-content>` is in context).

#### Gap 4: No Container Network Egress Filtering

The codebase exploration found this as the **most critical infrastructure gap**: agents can exfiltrate data via HTTP/DNS to any external host. Even with perfect prompt injection defense, a compromised agent can phone home.

**Fix:** Docker network policy with domain allowlist. This is independent of content pipes but compounds the blast radius.

#### Gap 5: No Multimodal Injection Defense

Emails contain images, PDFs, and HTML. Multimodal prompt injection (arXiv:2509.05883) is an active attack vector. The current pipe only sanitizes text.

**Fix:** Strip or separately process non-text content in Phase 2. At minimum, images should not be passed to the agent without explicit user request.

---

## Part 2: Current Security Posture

CamBot already has 17 security modules in cambot-core (~1800 LOC):

| Module | File | What It Does | Rating |
|---|---|---|---|
| Injection Detector | `cambot-core/src/security/injection-detector.ts` | 37 patterns, 7 categories, severity-based | Excellent |
| Input Sanitizer | `cambot-core/src/security/input-sanitizer.ts` | Null bytes, UTF-8, byte limits | Excellent |
| Circuit Breaker | `cambot-core/src/security/circuit-breaker.ts` | closed->warn->restrict->deny state machine | Excellent |
| Adaptive Thresholds | `cambot-core/src/security/adaptive-thresholds.ts` | Attack-responsive tightening (0.5x multiplier) | Excellent |
| Security Events | `cambot-core/src/security/security-events.ts` | Chain-hashed tamper-evident audit trail | Excellent |
| Canary Facts | `cambot-core/src/security/canary-facts.ts` | Honeypot facts, tripwire detection | Excellent |
| Memory Sanitizer | `cambot-core/src/security/memory-sanitizer.ts` | Injection scanning before memory promotion | Good |
| PII Tagger/Detector/Redactor | `cambot-core/src/security/pii-*.ts` | 8 PII pattern types, placeholder redaction | Good |
| Tool Registry | `cambot-core/src/tools/tool-registry.ts` | Multi-layer tool execution gate | Excellent |
| Anomaly Detector | `cambot-core/src/security/anomaly-detector.ts` | Rate & error threshold monitoring | Good |
| Security Monitor Hook | `cambot-core/src/hooks/security-monitor.ts` | Continuous observation at priority 10 | Good |
| Container Isolation | `cambot-agent/src/container/` | Ephemeral, non-root, read-only, mount allowlist | Excellent |
| IPC Authorization | `cambot-agent/src/ipc/message-handler.ts` | `isMain OR targetGroup === sourceGroup` | Excellent |

### Current Gaps (Ordered by Severity)

| # | Gap | Severity | Status |
|---|---|---|---|
| 1 | Container network unrestricted (data exfiltration) | **Critical** | Unaddressed |
| 2 | API key discoverable in container environment | **Critical** | Documented limitation |
| 3 | WhatsApp/Email/CLI bypass bus handler chain | **High** | Addressed by CONTENT-PIPES Phase 1 |
| 4 | No ML-based injection classifier | **High** | Addressed by this review (Phase 4) |
| 5 | No post-action auditing | **High** | Addressed by this review (Phase 6) |
| 6 | No container resource limits (DoS) | **High** | Needs Docker --memory/--cpus |
| 7 | Web channel unauthenticated | **High** | Planned: session auth + Tailscale |
| 8 | No MCP tool response verification | **Medium** | Optional HMAC verification |
| 9 | PII detection regex-only (context-blind) | **Medium** | LLM-assisted PII as future phase |
| 10 | JWT single shared secret | **Medium** | Rotating signing keys planned |

---

## Part 3: Research Landscape

### The Academic Consensus (2024-2026)

Prompt injection is a **fundamental architectural vulnerability, not an implementation bug.** There is no silver bullet.

Key findings:
- Input preprocessing achieves **60-80%** detection rates against known patterns
- Advanced architectural defenses achieve up to **95%** against known patterns but "significant gaps persist against novel attack vectors"
- Best-of-N attacks achieve **89% success on GPT-4o** and **78% on Claude 3.5 Sonnet** with sufficient attempts
- The CaMeL paper (DeepMind) proposes the most rigorous solution: a custom DSL with data-flow taint tracking, but it's complex and research-stage

### The Six Design Patterns (Willison/2025 Paper, arXiv:2506.08837)

| Pattern | Description | CamBot Relevance | In CONTENT-PIPES? |
|---|---|---|---|
| **Action-Selector** | LLM picks action, no feedback from tools | Low — too restrictive | No |
| **Plan-Then-Execute** | Plan before untrusted data exposure | Medium — for scheduled tasks | No |
| **LLM Map-Reduce** | Sub-agents process chunks independently | Low — emails are single docs | No |
| **Dual LLM** | Privileged + quarantined LLM separation | **High — this is what CONTENT-PIPES does** | **Yes** |
| **Code-Then-Execute** | CaMeL DSL + taint tracking | High but very complex | No |
| **Context-Minimization** | Strip prompt after query conversion | Medium — for structured queries | Partially |

### Key Papers

| Paper | Authors | Finding |
|---|---|---|
| "The Attacker Moves Second" (Oct 2025) | OpenAI/Anthropic/DeepMind (14 authors) | All 12 tested defenses bypassed with >90% success under adaptive attack |
| "Defeating Prompt Injections by Design" — CaMeL (Mar 2025) | DeepMind + ETH Zurich | Capability-based access control via DSL; 77% task completion with provable security |
| "Design Patterns for Securing LLM Agents" (Jun 2025) | Beurer-Kellner et al. | Six principled design patterns with 10 case studies |
| "Progent" (Apr 2025) | Privilege control framework | 0% attack success rate with preserved utility |
| "MiniScope" (Dec 2025) | Automatic privilege hierarchies | 1-6% latency overhead for least-privilege enforcement |
| "LlamaFirewall" (Apr 2025) | Meta | Reduced attack success from 17.6% to 1.7% on AgentDojo |
| "PISanitizer" (Nov 2025) | Attention-based sanitization | Novel approach using attention weights to detect injection tokens |

---

## Part 4: Commercial Tools Landscape

| Tool | Type | Pricing | Latency | Detection | Fit for CamBot |
|---|---|---|---|---|---|
| Lakera Guard | SaaS API | Commercial (per-call) | ~61ms | F1: 0.30 (independent test) | **No** — poor real-world detection, privacy risk |
| NeMo Guardrails | Open-source (Python) | Free | ~500ms | Good (Colang rails) | **Maybe** — for dialog-level rails in Phase 7 |
| LLM Guard | Open-source (Python) | Free | ~50-100ms | Good (multi-scanner) | **Yes** — adopt for input/output scanning |
| Prompt Guard 2 (86M) | Open-source classifier | Free (local) | ~18ms GPU / ~300ms CPU | 97.5% detection | **Yes** — adopt as pre-classifier |
| Prompt Guard 2 (22M) | Open-source classifier | Free (local) | ~5ms GPU / ~75ms CPU | Slightly lower | **Yes** — lighter alternative |
| LlamaFirewall | Open-source framework | Free | Variable | 98.3% block rate | **Yes** — adopt for CoT auditing |
| Sentinel Protocol | Open-source proxy | Free (local) | Low | 81 security engines | **Consider** — specifically for MCP security |
| Rebuff | Open-source multi-layer | Free | Variable | Moderate | **No** — still prototype, complex deps |
| AWS Bedrock Guardrails | Managed AWS service | Per-request | Low | High | **No** — AWS lock-in, not using Bedrock |
| PISanitizer | Research prototype | Free | Higher | Novel | **No** — not production-ready yet |

### Why Not Buy SaaS

1. **Privacy**: CamBot processes personal emails. Sending them to a third-party API for scanning creates a new data exposure vector.
2. **Performance**: Independent benchmarks show Lakera Guard at F1: 0.30 on real-world datasets — our existing regex detector likely outperforms this.
3. **Dependency**: SaaS pricing is opaque and can change. Open-source alternatives are strictly better for this use case.
4. **Latency**: Adding a network hop to every message adds 50-100ms+ per call.

---

## Part 5: Build vs Buy Decision Matrix

### Build (Custom to CamBot)

| Component | Why Custom | Designed? |
|---|---|---|
| Bus unification | CamBot-specific infrastructure | Yes — CONTENT-PIPES Phase 1 |
| Content pipe handler | Tied to bus, IPC, container arch | Yes — CONTENT-PIPES Phase 2 |
| Gmail MCP adapter | Specific to MCP integration | Yes — CONTENT-PIPES Phase 3 |
| Envelope format | Coupled to system prompt and agent behavior | Yes — CONTENT-PIPES Phase 2 |
| Post-action auditor / tool gating | Unique to circuit breaker + tool registry | **No — needs design** |
| Container network egress filtering | Docker-level, CamBot-specific | **No — needs design** |
| Prompt Guard 2 integration service | Microservice wrapping the model for CamBot's pipeline | **No — needs design** |

### Adopt (Open-Source, Free)

| Tool | Purpose | Integration Method |
|---|---|---|
| **Prompt Guard 2 (22M or 86M)** | ML classifier for injection detection | Python microservice via uv, called from content pipe |
| **LlamaFirewall** | Agent alignment / CoT auditing | Python sidecar service, called post-tool-execution |
| **LLM Guard** | Multi-scanner pipeline (fallback/supplementary) | Python microservice via uv, optional layer |

### Do Not Build

| Approach | Why Skip |
|---|---|
| CaMeL-style DSL + taint tracking | Research prototype, not production-ready. Monitor for maturity. |
| Custom ML classifier | Prompt Guard 2 already exists, is better than what we'd train |
| LLM-as-a-Judge for security | Research shows it shares the same vulnerabilities as the system it protects |
| Custom PII detection model | Existing regex + future LLM pass is sufficient |

---

## Part 6: Implementation Roadmap

### Phase 1: Bus Unification (Prerequisite)

> Reference: [CONTENT-PIPES.md](./CONTENT-PIPES.md) — "Prerequisite: Unified Bus Inbound Path"

- ~20 lines across 8 files, no new deps
- Closes the bypass where WhatsApp/Email/CLI skip the bus
- All downstream security (content pipe, auditing) depends on this

### Phase 2: Content Pipe + Envelope

> Reference: [CONTENT-PIPES.md](./CONTENT-PIPES.md) — "Solution: Bus-Based Content Pipe"

- Dual LLM pattern: Haiku summarizer with zero tools
- Raw content store with TTL
- Envelope formatter with safety flags
- `read_raw_content` IPC tool with `<untrusted-content>` markers

### Phase 3: Gmail MCP Adapter

> Reference: [CONTENT-PIPES.md](./CONTENT-PIPES.md) — "MCP Tool Access Control: Gmail Adapter"

- Replace `search_gmail_messages` / `get_gmail_message` with wrapped `check_email` / `read_email`
- All email content flows through content pipe regardless of path

### Phase 4: ML Pre-Classifier (NEW)

Add Prompt Guard 2 as a pre-filter before the Haiku summarizer call.

**Architecture:**
```
content-pipe-handler.ts (priority 20)
  |
  v
  1. Input sanitizer (existing, null bytes/encoding)
  2. Regex injection detector (existing, 37 patterns)
  3. Prompt Guard 2 classifier (NEW)
     |
     +-- clean (score < 0.3): skip Haiku, build envelope from metadata only
     +-- ambiguous (0.3-0.7): proceed to Haiku summarizer
     +-- injection (> 0.7): flag high severity, proceed to Haiku
     +-- critical (> 0.9): flag critical, optionally block
  4. Haiku summarizer (existing design, only for ambiguous/flagged)
  5. Build envelope
```

**Implementation:**
- Run Prompt Guard 2 (22M) as a Python microservice via uv
- HTTP endpoint: `POST /classify` with `{ text: string }` -> `{ score: number, label: string }`
- Content pipe calls this before Haiku
- ~4-8 hours development

**Cost impact:** Reduces Haiku calls by ~80-95% (most messages are clean). Net savings on LLM costs.

### Phase 5: Container Network Egress (NEW)

Restrict container outbound network access to an allowlist.

**Implementation options:**
1. Docker network with `--network=cambot-restricted` + iptables/nftables rules
2. Docker `--dns` pointing to a filtering DNS resolver
3. Proxy-based: route all container HTTP through a filtering proxy

**Allowlist (minimum):**
- `api.anthropic.com` (LLM calls)
- `api.openai.com` (LLM calls)
- `generativelanguage.googleapis.com` (LLM calls)
- `host.docker.internal` (workspace-mcp, IPC)
- Block everything else

**Impact:** Closes data exfiltration even if prompt injection succeeds.

### Phase 6: Post-Action Auditor (NEW)

Gate sensitive tools when the agent is processing untrusted content.

**Implementation:**
- Track "untrusted context active" state per container session
- Set when content pipe processes a message for a group
- Clear after agent's response to the piped message
- While active, require user confirmation for:
  - `send_gmail_message`
  - `send_message` (to non-source JIDs)
  - `schedule_task`
  - `register_group`
  - `create_custom_agent`

**Integration point:** Extend the existing circuit breaker or add a new `UntrustedContextGate` that wraps the tool execution gate in `tool-registry.ts`.

**Optional enhancement:** Integrate LlamaFirewall's Agent Alignment Checks to audit the agent's chain-of-thought reasoning before executing gated tools.

### Phase 7: NeMo Guardrails (OPTIONAL/FUTURE)

Dialog-level rails for agent tool usage patterns using Colang DSL. Only pursue if Phase 6 proves insufficient.

---

## Cost Summary

| Phase | Dev Effort | Ongoing Cost | Risk Reduction |
|---|---|---|---|
| 1: Bus unification | ~2-4 hrs | $0 | High (architectural prerequisite) |
| 2: Content pipe | ~8-16 hrs | ~$0.001/email (Haiku) | Very high (core defense) |
| 3: Gmail adapter | ~4-8 hrs | $0 | High (closes bypass) |
| 4: Prompt Guard 2 | ~4-8 hrs | ~$0 (local CPU) | High (97.5% detection) |
| 5: Network egress | ~2-4 hrs | $0 | Critical (exfiltration defense) |
| 6: Post-action audit | ~8-16 hrs | $0 | High (limits blast radius) |
| **Total** | **~28-56 hrs** | **~$0.001/email** | |

No SaaS costs. No vendor dependencies. All open-source.

---

## Residual Risk (Honest Assessment)

Even with all phases complete, a sufficiently sophisticated attacker can still:

1. **Craft misleading summaries** — The quarantined Haiku can be influenced to produce benign-looking summaries of malicious content. Mitigation: regex detection runs independently and flags regardless of summary.

2. **Exploit raw content access** — When the user explicitly requests raw content, it enters the agent's context with tool access. Mitigation: Phase 6 gates sensitive tools during untrusted context.

3. **Use novel obfuscation** — "The Attacker Moves Second" proved all static defenses can be bypassed. Mitigation: Prompt Guard 2 catches patterns beyond regex; layered defense forces attacker to bypass multiple systems.

4. **Exploit multimodal vectors** — Image/PDF-based injection bypasses text-only pipes. Mitigation: strip non-text content, process separately.

5. **Exfiltrate via allowed domains** — If the agent can reach `api.anthropic.com`, a creative injection could encode data in API calls. Mitigation: monitor API call patterns via anomaly detector.

This is consistent with the academic consensus: prompt injection is a fundamental architectural vulnerability of current LLM systems, not an implementation bug. The goal is to make attacks expensive, detectable, and limited in blast radius — not to achieve 100% prevention.

---

## Sources

### OWASP
- [LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [OWASP Top 10 for LLM Applications 2025 (PDF)](https://owasp.org/www-project-top-10-for-large-language-model-applications/assets/PDF/OWASP-Top-10-for-LLMs-v2025.pdf)

### Academic Research
- [Design Patterns for Securing LLM Agents (arXiv:2506.08837)](https://arxiv.org/pdf/2506.08837)
- [The Attacker Moves Second (arXiv:2510.09023)](https://arxiv.org/abs/2510.09023)
- [CaMeL: Defeating Prompt Injections by Design (arXiv:2503.18813)](https://arxiv.org/abs/2503.18813)
- [Progent: Programmable Privilege Control (arXiv:2504.11703)](https://arxiv.org/abs/2504.11703)
- [MiniScope: Least Privilege Framework (arXiv:2512.11147)](https://arxiv.org/abs/2512.11147)
- [PISanitizer (arXiv:2511.10720)](https://arxiv.org/abs/2511.10720)
- [LLM-as-a-Judge Vulnerabilities (arXiv:2505.13348)](https://arxiv.org/abs/2505.13348)
- [Comprehensive Review: Prompt Injection (MDPI)](https://www.mdpi.com/2078-2489/17/1/54)
- [Multimodal Prompt Injection (arXiv:2509.05883)](https://arxiv.org/html/2509.05883v1)
- [Prompt Injection in Third-Party Plugins (IEEE S&P 2026)](https://arxiv.org/abs/2511.05797)
- [SEAgent: Mandatory Access Control (arXiv:2601.11893)](https://arxiv.org/abs/2601.11893)
- [PromptGuard Framework (Nature Scientific Reports)](https://www.nature.com/articles/s41598-025-31086-y)

### Tools & Frameworks
- [Meta Prompt Guard 2 (HuggingFace)](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
- [LlamaFirewall (GitHub)](https://github.com/meta-llama/PurpleLlama/tree/main/LlamaFirewall)
- [LLM Guard (GitHub)](https://github.com/protectai/llm-guard)
- [NeMo Guardrails (GitHub)](https://github.com/NVIDIA-NeMo/Guardrails)
- [Sentinel Protocol (GitHub)](https://github.com/6desk/sentinel)
- [Rebuff (GitHub)](https://github.com/protectai/rebuff)
- [PISanitizer (GitHub)](https://github.com/sleeepeer/PISanitizer)
- [Prompt Injection Defenses Collection (GitHub)](https://github.com/tldrsec/prompt-injection-defenses)
- [Lakera Guard](https://www.lakera.ai/lakera-guard)

### Industry Analysis
- [Simon Willison: Design Patterns for Securing LLM Agents](https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/)
- [Simon Willison: The Lethal Trifecta for AI Agents](https://simonw.substack.com/p/the-lethal-trifecta-for-ai-agents)
- [NeuralTrust: Firewall Comparison](https://neuraltrust.ai/blog/prevent-prompt-injection-attacks-firewall-comparison)
- [Lakera: Why LLM-as-a-Judge Fails](https://www.lakera.ai/blog/stop-letting-models-grade-their-own-homework-why-llm-as-a-judge-fails-at-prompt-injection-defense)
- [Lakera: Indirect Prompt Injection](https://www.lakera.ai/blog/indirect-prompt-injection)
- [Langfuse: Security & Guardrails](https://langfuse.com/docs/security-and-guardrails)
- [The Crisis of Agency (Robison, 2026)](https://gregrobison.medium.com/the-crisis-of-agency-a-comprehensive-analysis-of-prompt-injection-and-the-security-architecture-of-d274524b3c11)
- [Google Security Blog: Layered Defense](https://security.googleblog.com/2025/06/mitigating-prompt-injection-attacks.html)

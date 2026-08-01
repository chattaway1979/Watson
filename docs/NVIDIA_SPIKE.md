# Watson × NVIDIA Agent Stack — Compatibility Spike

Isolated written assessment (no code added to the endpoint core; **no NVIDIA runtime dependency was introduced**).
Verified against current NVIDIA docs (Aug 2026). The endpoint implementation was completed **first**; this did not
delay it.

## Bottom line
NVIDIA's agent stack can **wrap, observe, sandbox, and serve Watson's reasoning layer** — it does **not** replace, and
should not replace, Watson's deterministic endpoint **policy + executor**, and it does **not** help the current real-device
blocker (which is a designated non-production Windows test device, not AI infrastructure). Nothing here requires a Watson
redesign; every option is additive behind an existing seam.

## Component assessments

### A. NeMo Agent Toolkit (`nvidia-nat`, v1.8, open source, Python)
Framework-agnostic library to connect, **evaluate, observe, profile, and optimize** agent workflows via OpenTelemetry
(works with LangChain/LlamaIndex/CrewAI/Semantic Kernel/custom Python). Not a model; instrumentation + eval/profiling.
- **Watson fit:** trace case IDs, operation IDs, policy decisions, tool calls, approvals, and verification as spans;
  add eval/profiling for the reasoning layer. Integrates *around* Watson without a rewrite.
- **Caveat:** Watson's endpoint decisions are **deterministic today** (no heavy LLM agent loop), so the value lands once
  Watson adds model-driven reasoning. Python-side (Watson is TypeScript) → it instruments the model/reasoning service, not
  the endpoint executor. No GPU needed for the toolkit itself.
- **Verdict: PILOT LATER** (when LLM reasoning/eval matters).

### B. NVIDIA OpenShell (open source, sandbox runtime)
Kernel-level sandbox for autonomous agents with a **declarative YAML policy** over filesystem, outbound network, process
execution, and inference routing; a gateway evaluates agent actions before they reach the host. Supported clients include
**Claude**, Codex, Copilot CLI.
- **Watson fit:** strong **defense-in-depth for Watson's cloud reasoning / tool-use host** — restrict the agent host to
  only Watson's typed API, block arbitrary fs/net/process. Complements (does not replace) the deterministic endpoint gate.
- **Caveat:** kernel-level isolation ⇒ **Linux/containers (WSL2)**, not native Windows and **not the managed employee
  endpoint**. It secures the *brain host*, not the *device*. Adds operational complexity.
- **Verdict: PILOT LATER** (adopt for the reasoning/orchestrator host if/when Watson runs model-driven tool use).
- **Important:** OpenShell is **not** a licence to expose a generic shell to Watson. The endpoint stays typed-allowlist only.

### C. NVIDIA NIM (inference microservices)
Containerized, **OpenAI-compatible** model serving; requires **NVIDIA GPUs**.
- **Watson fit:** add a `NimProvider` behind the existing `AiProvider` seam for classification/summarization/embeddings/
  (optionally) reasoning — **without touching endpoint controls**. Provider abstraction already exists.
- **Caveat:** needs GPU hardware/containers not currently available to H&R; self-hosting is an infra project.
- **Verdict: DEFER** until GPU infra exists; trivial to add behind the provider seam when it does.

### D. NVIDIA Riva (speech AI)
GPU-accelerated streaming **ASR + TTS** with custom vocabulary; container deploy.
- **Watson fit:** the planned **voice-first** interface (STT for intake, TTS for responses), custom IT vocabulary.
- **Caveat:** GPU + containers; only relevant once voice-first is prioritized.
- **Verdict: DEFER** (adopt when voice-first is scheduled).

## Decision matrix
| Component | Watson use case | Immediate value | Future value | Integration effort | Hardware | Licensing | Platform limit | Security impact | Recommendation |
|-----------|-----------------|-----------------|--------------|--------------------|----------|-----------|----------------|-----------------|----------------|
| NeMo Agent Toolkit | Trace/eval/profile reasoning | Low | High | Low–Med (Python, wraps) | None (CPU) | Open source | Python-side | Neutral (observability) | **PILOT LATER** |
| OpenShell | Sandbox the reasoning host | Low | High | Med (Linux/containers) | None req'd | Open source | Linux/WSL, not Windows endpoint | Strong + (host isolation) | **PILOT LATER** |
| NIM | Self-hosted model serving | Low | Med–High | Low (provider seam) | NVIDIA GPU | NVIDIA AI Enterprise for prod | GPU/containers | Neutral | **DEFER** |
| Riva | Voice-first STT/TTS | None now | Med | Med | NVIDIA GPU | NVIDIA licensing | GPU/containers | Neutral | **DEFER** |

## The eight required questions
1. **Reduce development time?** Marginally (NAT eval/observability). Not for the endpoint work.
2. **Reduce operational risk?** OpenShell yes, for the *reasoning host*; nothing reduces endpoint risk (already deterministic).
3. **Improve safety?** OpenShell adds host-level defense-in-depth; none replace or weaken the deterministic endpoint gate.
4. **Require Watson redesign?** No — all additive (NAT wraps, OpenShell hosts, NIM/Riva sit behind provider seams).
5. **Vendor lock-in?** NAT/OpenShell open source (low). NIM/Riva tie value to NVIDIA GPUs (moderate hardware lock-in).
6. **Interfere with Claude/OpenAI use?** No — NAT is framework-agnostic; OpenShell explicitly supports Claude; NIM is an
   *additional* provider; Riva is speech only.
7. **Help the real endpoint blocker?** **No.** None give Windows device control. The blocker is a designated non-prod test
   device — an operational/hardware gate, not AI infrastructure.
8. **Integrate now vs later?** **Now: none** (endpoint first). **Later:** OpenShell + NeMo Agent Toolkit when Watson runs
   model-driven reasoning; NIM when GPU infra exists; Riva when voice-first is scheduled.

## Recommendation
- **Now:** integrate nothing from NVIDIA; keep the deterministic endpoint core and finish the real-device proof.
- **Later (in order):** (1) OpenShell to sandbox the reasoning/orchestrator host once LLM tool-use is added; (2) NeMo Agent
  Toolkit for tracing/eval of that reasoning; (3) NIM behind `AiProvider` when GPUs are available; (4) Riva for voice-first.
- **Never:** let any NVIDIA component perform endpoint actions directly or bypass the typed allowlist / policy / verification.

Sources: NeMo Agent Toolkit — https://github.com/NVIDIA/NeMo-Agent-Toolkit , https://docs.nvidia.com/nemo/agent-toolkit/latest/index.html ;
OpenShell — https://github.com/NVIDIA/OpenShell , https://docs.nvidia.com/openshell/about/overview , https://blogs.nvidia.com/blog/secure-autonomous-ai-agents-openshell/

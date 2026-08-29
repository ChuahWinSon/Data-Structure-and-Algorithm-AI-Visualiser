import React, { useState, useMemo, useRef, useEffect } from "react";

const MARKER = "%%%WHITEBOARD%%%";

const DRAW_PREFIX_RE = /^visuali[sz]e\s*:\s*/i;

function buildSystemPrompt(wantsDraw) {
  const base = "You are a friendly DSA tutor chatting with a student. Chat normally in plain text explanations.";
  if (!wantsDraw) {
    return base + " Do not produce any diagram, JSON, or the whiteboard marker in this reply, even if a visual would help - just explain in words. The whiteboard only updates when the student explicitly asks for it, which is not the case this turn.";
  }
  return base + ` The student explicitly asked for a drawing this turn. Give a brief explanation first (a sentence or two, or skip it if the JSON speaks for itself), then end your reply with, in this exact order:
1. On its own line, exactly this marker: ${MARKER}
2. Then, immediately after with nothing else around it, ONLY valid JSON matching this shape (no markdown code fences):
{"nodes":[{"id":"a","label":"8","subtitle":""}],"edges":[["a","b"]],"steps":[{"title":"...","description":"...","highlight":["a"],"activeEdge":["a","b"],"pruned":[],"bubble":{"node":"a","lines":["..."]},"answer":null}]}

Rules for the JSON:
- ids are short unique strings, label is the value shown in the node, edges are directed [parentId, childId] pairs forming one tree.
- Keep to 16 nodes and 16 steps or fewer so the reply doesn't run out of room.
- Never use a double-quote character inside any string value anywhere in the JSON - rephrase instead of quoting something.
- activeEdge, pruned, bubble and answer may be omitted or null on steps where they don't apply.
- Nothing may come after the JSON. It must be the very last thing in your reply.`;
}

function computeLayout(nodes, edges) {
  const childrenMap = {};
  const parentSet = new Set();
  edges.forEach(([p, c]) => {
    childrenMap[p] = childrenMap[p] || [];
    childrenMap[p].push(c);
    parentSet.add(c);
  });
  const root = nodes.find((n) => !parentSet.has(n.id)) || nodes[0];

  const visited = new Set();
  const queue = [root.id];
  let valid = true;
  while (queue.length) {
    const cur = queue.shift();
    if (visited.has(cur)) { valid = false; break; }
    visited.add(cur);
    (childrenMap[cur] || []).forEach((c) => queue.push(c));
  }
  if (!valid || visited.size !== nodes.length) {
    const perRow = 4;
    const pos = {};
    nodes.forEach((n, i) => { pos[n.id] = { x: 90 + (i % perRow) * 150, y: 60 + Math.floor(i / perRow) * 110 }; });
    return { positions: pos, width: Math.min(perRow, nodes.length) * 150 + 60, height: 60 + Math.ceil(nodes.length / perRow) * 110 + 40 };
  }

  let counter = 0;
  const slot = {}, depthOf = {};
  function assign(id, depth) {
    depthOf[id] = depth;
    const kids = childrenMap[id] || [];
    let x;
    if (kids.length === 0) { x = counter; counter += 1; }
    else { const xs = kids.map((k) => assign(k, depth + 1)); x = (Math.min(...xs) + Math.max(...xs)) / 2; }
    slot[id] = x;
    return x;
  }
  assign(root.id, 0);

  const spacingX = 72, marginX = 40;
  const positions = {};
  let maxDepth = 0, maxPixelX = 0;
  nodes.forEach((n) => {
    const depth = depthOf[n.id] ?? 0;
    if (depth > maxDepth) maxDepth = depth;
    const px = marginX + slot[n.id] * spacingX;
    if (px > maxPixelX) maxPixelX = px;
    positions[n.id] = { x: px, y: 50 + depth * 90 };
  });
  return { positions, width: maxPixelX + marginX, height: 50 + maxDepth * 90 + 50 };
}

function chatPortion(content) {
  const idx = content.indexOf(MARKER);
  return (idx === -1 ? content : content.slice(0, idx)).trim();
}

// ---- design tokens ----
const COLOR = {
  bg: "#ffffff",
  panelBorder: "#e4e4e7",
  ink: "#18181b",
  inkSoft: "#3f3f46",
  muted: "#71717a",
  faint: "#a1a1aa",
  surface: "#fafafa",
  surfaceRaised: "#f4f4f5",
  accent: "#4f46e5",
  accentSoft: "#eef2ff",
  danger: "#dc2626",
  dangerSoft: "#fef2f2",
  warn: "#b45309",
  warnSoft: "#fffbeb",
  amber: "#f59e0b",
  green: "#16a34a",
};

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
.dw-shell { font-family: ${FONT}; }
.dw-msg { animation: dw-fade-up 0.25s ease-out; }
@keyframes dw-fade-up { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.dw-dot { animation: dw-pulse 1.2s ease-in-out infinite; }
.dw-dot:nth-child(2) { animation-delay: 0.15s; }
.dw-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes dw-pulse { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
.dw-input:focus { outline: none; border-color: ${COLOR.accent} !important; box-shadow: 0 0 0 3px ${COLOR.accentSoft}; }
.dw-send:hover:not(:disabled) { background: #000 !important; }
.dw-step:hover:not(.dw-step-active) { border-color: ${COLOR.ink} !important; color: ${COLOR.ink} !important; }
.dw-recall:hover { color: ${COLOR.ink} !important; }
.dw-recall:focus-visible, .dw-send:focus-visible, .dw-step:focus-visible { outline: 2px solid ${COLOR.accent}; outline-offset: 2px; }
`;

export default function DsaWhiteboardChat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [whiteboard, setWhiteboard] = useState(null);
  const [stepIndex, setStepIndex] = useState(0);
  const chatEndRef = useRef(null);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const layout = useMemo(() => whiteboard ? computeLayout(whiteboard.nodes, whiteboard.edges) : null, [whiteboard]);

  async function sendMessage(rawText) {
    if (!rawText.trim() || loading) return;
    const wantsDraw = DRAW_PREFIX_RE.test(rawText.trim());
    const stripped = wantsDraw ? rawText.trim().replace(DRAW_PREFIX_RE, "").trim() : rawText;
    const text = wantsDraw && !stripped ? "Please visualize what we just discussed." : stripped;
    setLoading(true);
    setError(null);
    const base = [...messages, { role: "user", content: text }];
    setMessages(base);
    setInput("");
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: buildSystemPrompt(wantsDraw),
          messages: base.map(({ role, content }) => ({ role, content })),
        }),
      });
      const json = await response.json();
      if (json.error) throw new Error(json.error.message || "API error");
      const textBlock = (json.content || []).find((b) => b.type === "text");
      const fullText = textBlock ? textBlock.text : "";

      let parsedWb = null;
      const idx = fullText.indexOf(MARKER);
      if (idx !== -1) {
        let jsonPart = fullText.slice(idx + MARKER.length).trim();
        jsonPart = jsonPart.replace(/```json|```/g, "").trim();
        try {
          const parsed = JSON.parse(jsonPart);
          if (parsed.nodes && parsed.edges && parsed.steps) parsedWb = parsed;
        } catch (e) {
          setError("Couldn't parse the whiteboard JSON. Raw tail: " + jsonPart.slice(0, 180));
        }
      }

      setMessages([...base, { role: "assistant", content: fullText, whiteboard: parsedWb }]);
      if (parsedWb) {
        setWhiteboard(parsedWb);
        setStepIndex(0);
      }
      if (json.stop_reason === "max_tokens") {
        setError((prev) => (prev ? prev + " " : "") + "That reply got cut off — try asking for something smaller.");
      }
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  const step = whiteboard ? whiteboard.steps[stepIndex] : null;
  const highlighted = new Set(step?.highlight || []);
  const pruned = new Set(step?.pruned || []);

  return (
    <div className="dw-shell" style={{ display: "flex", gap: 16, width: "100%", flexWrap: "wrap" }}>
      <style>{CSS}</style>

      {/* Chat panel */}
      <div style={{
        flex: "1 1 340px", minWidth: 300, height: 580, display: "flex", flexDirection: "column",
        background: COLOR.bg, border: `1px solid ${COLOR.panelBorder}`, borderRadius: 16,
        boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.03)", overflow: "hidden",
      }}>
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${COLOR.panelBorder}` }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: COLOR.faint }}>
            Chat
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          {messages.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: COLOR.faint, fontSize: 13, maxWidth: 220 }}>
              Ask about any algorithm or data structure to get started.
            </div>
          )}
          {messages.map((m, i) => {
            const text = m.role === "assistant" ? chatPortion(m.content) : m.content;
            const attemptedDraw = m.role === "assistant" && m.content.includes(MARKER);
            const isActive = m.whiteboard && whiteboard === m.whiteboard;
            return (
              <div key={i} className="dw-msg" style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "82%" }}>
                {text && (
                  <div style={{
                    padding: "9px 13px", borderRadius: m.role === "user" ? "14px 14px 3px 14px" : "14px 14px 14px 3px",
                    fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap",
                    background: m.role === "user" ? COLOR.ink : COLOR.surfaceRaised,
                    color: m.role === "user" ? "#fff" : COLOR.inkSoft,
                  }}>
                    {text}
                  </div>
                )}
                {m.whiteboard && (
                  <button
                    className="dw-recall"
                    onClick={() => { setWhiteboard(m.whiteboard); setStepIndex(0); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, marginTop: 6,
                      background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: FONT,
                      color: isActive ? COLOR.accent : COLOR.muted, fontWeight: isActive ? 600 : 500,
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 12h8M8 8h5M8 16h4" />
                    </svg>
                    {isActive ? "Viewing this whiteboard" : "View this whiteboard"}
                  </button>
                )}
                {attemptedDraw && !m.whiteboard && (
                  <div style={{ fontSize: 11.5, color: COLOR.warn, marginTop: 6 }}>Tried to draw, but the data didn't parse</div>
                )}
              </div>
            );
          })}
          {loading && (
            <div style={{ display: "flex", gap: 4, padding: "9px 13px" }}>
              <span className="dw-dot" style={{ width: 5, height: 5, borderRadius: 999, background: COLOR.faint, display: "inline-block" }} />
              <span className="dw-dot" style={{ width: 5, height: 5, borderRadius: 999, background: COLOR.faint, display: "inline-block" }} />
              <span className="dw-dot" style={{ width: 5, height: 5, borderRadius: 999, background: COLOR.faint, display: "inline-block" }} />
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {error && (
          <div style={{ margin: "0 16px 12px", padding: "8px 12px", borderRadius: 10, fontSize: 12.5, color: COLOR.danger, background: COLOR.dangerSoft, borderLeft: `3px solid ${COLOR.danger}` }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, padding: 12, borderTop: `1px solid ${COLOR.panelBorder}` }}>
          <input
            className="dw-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage(input)}
            placeholder="Ask, or start with 'visualise:' to draw..."
            style={{
              flex: 1, padding: "9px 13px", borderRadius: 10, border: `1px solid ${COLOR.panelBorder}`,
              fontSize: 14, fontFamily: FONT, color: COLOR.ink, transition: "box-shadow 0.15s, border-color 0.15s",
            }}
          />
          <button
            className="dw-send"
            onClick={() => sendMessage(input)}
            disabled={loading || !input.trim()}
            style={{
              padding: "0 16px", borderRadius: 10, border: "none", background: COLOR.ink, color: "#fff",
              fontSize: 14, fontWeight: 500, fontFamily: FONT, cursor: loading || !input.trim() ? "default" : "pointer",
              opacity: loading || !input.trim() ? 0.4 : 1, transition: "background 0.15s",
            }}
          >
            Send
          </button>
        </div>
      </div>

      {/* Whiteboard panel */}
      <div style={{
        flex: "1 1 400px", minWidth: 320, display: "flex", flexDirection: "column", gap: 14,
        background: COLOR.bg, border: `1px solid ${COLOR.panelBorder}`, borderRadius: 16,
        boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.03)", padding: 16,
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: COLOR.faint }}>
          Whiteboard
        </div>

        {!whiteboard && (
          <div style={{
            flex: 1, minHeight: 220, display: "flex", flexDirection: "column", gap: 8, alignItems: "center", justifyContent: "center",
            border: `1.5px dashed ${COLOR.panelBorder}`, borderRadius: 12, color: COLOR.faint,
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7" cy="6" r="2.2" /><circle cx="17" cy="6" r="2.2" /><circle cx="12" cy="17" r="2.2" />
              <path d="M8.7 7.4L11 15.2M15.3 7.4L13 15.2" />
            </svg>
            <div style={{ fontSize: 13 }}>Nothing to show yet</div>
          </div>
        )}

        {whiteboard && layout && (
          <>
            <svg viewBox={`0 0 ${layout.width} ${layout.height}`}
              style={{
                background: COLOR.surface, borderRadius: 12, border: `1px solid ${COLOR.panelBorder}`,
                width: "100%", height: 420, display: "block",
              }}>
              {whiteboard.edges.map(([a, b], i) => {
                const from = layout.positions[a], to = layout.positions[b];
                if (!from || !to) return null;
                const isActive = step.activeEdge && ((step.activeEdge[0] === a && step.activeEdge[1] === b) || (step.activeEdge[0] === b && step.activeEdge[1] === a));
                const isPrunedEdge = pruned.has(a) || pruned.has(b);
                return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                  stroke={isActive ? COLOR.amber : isPrunedEdge ? "#e4e4e7" : "#d4d4d8"}
                  strokeWidth={isActive ? 3 : 1.5} strokeDasharray={isPrunedEdge ? "4 3" : undefined} />;
              })}
              {whiteboard.nodes.map((n) => {
                const pos = layout.positions[n.id];
                if (!pos) return null;
                const isAnswer = step.answer === n.id;
                const isHighlighted = highlighted.has(n.id);
                const isPruned = pruned.has(n.id);
                const fill = isAnswer ? COLOR.green : isHighlighted ? COLOR.amber : isPruned ? COLOR.surfaceRaised : "#ffffff";
                const textFill = isAnswer || isHighlighted ? "#ffffff" : isPruned ? COLOR.faint : COLOR.ink;
                return (
                  <g key={n.id} opacity={isPruned ? 0.55 : 1}>
                    <circle cx={pos.x} cy={pos.y} r={20} fill={fill}
                      stroke={isHighlighted || isAnswer ? "transparent" : isPruned ? "#d4d4d8" : "#a1a1aa"}
                      strokeWidth={1.5} strokeDasharray={isPruned ? "3 2" : undefined}
                      style={{ filter: isHighlighted || isAnswer ? "drop-shadow(0 2px 4px rgba(0,0,0,0.12))" : "none" }} />
                    <text x={pos.x} y={pos.y - (n.subtitle ? 3 : 0)} textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600} fontFamily={FONT} fill={textFill}>{n.label}</text>
                    {n.subtitle ? <text x={pos.x} y={pos.y + 32} textAnchor="middle" fontSize={9} fontFamily={FONT} fill={COLOR.muted}>{n.subtitle}</text> : null}
                  </g>
                );
              })}
              {step?.bubble && (() => {
                const node = layout.positions[step.bubble.node];
                if (!node) return null;
                const lines = step.bubble.lines || [];
                const charW = 6, lineH = 15;
                const boxW = Math.min(200, Math.max(120, Math.max(...lines.map((l) => l.length), 1) * charW + 20));
                const boxH = lines.length * lineH + 14;
                let bx = node.x + 26, by = node.y - boxH - 20;
                if (by < 8) by = node.y + 26;
                if (bx + boxW > layout.width - 8) bx = node.x - boxW - 26;
                if (bx < 8) bx = 8;
                const tailX = bx < node.x ? bx + boxW : bx;
                return (
                  <g>
                    <line x1={node.x} y1={node.y} x2={tailX} y2={by + boxH / 2} stroke="#a1a1aa" strokeWidth={1} strokeDasharray="2 2" />
                    <rect x={bx} y={by} width={boxW} height={boxH} rx={9} fill={COLOR.ink} style={{ filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.18))" }} />
                    {lines.map((l, i) => <text key={i} x={bx + 10} y={by + 14 + i * lineH} fontFamily="'SF Mono', 'Fira Code', monospace" fontSize={10} fill="#f4f4f5">{l}</text>)}
                  </g>
                );
              })()}
            </svg>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {whiteboard.steps.map((s, i) => (
                <button key={i} className={`dw-step${i === stepIndex ? " dw-step-active" : ""}`} onClick={() => setStepIndex(i)}
                  style={{
                    width: 30, height: 30, borderRadius: 999, fontFamily: FONT, transition: "all 0.12s",
                    border: i === stepIndex ? `1.5px solid ${COLOR.ink}` : `1px solid ${COLOR.panelBorder}`,
                    background: i === stepIndex ? COLOR.ink : "#fff",
                    color: i === stepIndex ? "#fff" : COLOR.muted,
                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}>{i + 1}</button>
              ))}
            </div>

            <div style={{ padding: "12px 14px", borderRadius: 12, background: COLOR.surfaceRaised, border: `1px solid ${COLOR.panelBorder}` }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: COLOR.ink }}>
                Step {stepIndex + 1} · {step.title}
              </div>
              <div style={{ fontSize: 13, color: COLOR.inkSoft, lineHeight: 1.55 }}>{step.description}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

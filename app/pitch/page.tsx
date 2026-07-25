"use client";

// React-Version des Pitch-Decks (pitch/index.html), damit das Deck unter
// /pitch auf der Live-URL erreichbar ist. Inhalt und Look sind bewusst
// selbsttragend (eigene Tokens), unabhaengig vom globalen App-Theme.
// Screenshots: Dateien in public/pitch-screenshots/ ablegen (gleiche Namen
// wie in pitch/screenshots/ fuer die Standalone-Datei).

import { useEffect, useRef, useState } from "react";

const css = `
  .deck {
    --ink-850: #0a1013;
    --ink-800: #0d1418;
    --ink-750: #111a1e;
    --rule: #1b272c;
    --rule-2: #29383e;
    --text: #e9eff1;
    --text-soft: #9aaab0;
    --text-faint: #82949b;
    --mint: #00ff7f;
    --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
    height: 100dvh;
    overflow-y: auto;
    scroll-snap-type: y mandatory;
    scroll-behavior: smooth;
    background: var(--ink-850);
    color: var(--text);
    font-family: var(--sans);
    -webkit-font-smoothing: antialiased;
  }
  .deck section {
    min-height: 100dvh;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 6vh 7vw;
    border-bottom: 1px solid var(--rule);
    box-sizing: border-box;
  }
  .deck .kicker {
    font-family: var(--mono);
    font-size: 22px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--mint);
    margin: 0 0 28px;
  }
  .deck h1 {
    font-size: clamp(52px, 6.4vw, 104px);
    line-height: 1.02;
    letter-spacing: -0.02em;
    font-weight: 700;
    max-width: 18ch;
    margin: 0 0 40px;
  }
  .deck h1 .dim { color: var(--text-faint); }
  .deck p { margin: 0; font-size: clamp(28px, 2.2vw, 36px); line-height: 1.45; }
  .deck .lines { display: grid; gap: 18px; max-width: 62ch; }
  .deck .lines p { color: var(--text-soft); }
  .deck .lines p strong { color: var(--text); font-weight: 600; }
  .deck .punch {
    border-left: 4px solid var(--mint);
    padding-left: 24px;
    color: var(--text) !important;
  }
  .deck .mint { color: var(--mint); }
  .deck .mono { font-family: var(--mono); }
  @media (max-height: 860px) {
    .deck h1 { font-size: clamp(38px, 5vw, 72px); margin-bottom: 24px; }
    .deck p { font-size: clamp(21px, 1.8vw, 28px); }
    .deck .kicker { font-size: 18px; margin-bottom: 18px; }
    .deck .closing { font-size: clamp(32px, 3.8vw, 56px); }
  }
  .deck .split { display: grid; grid-template-columns: 1.05fr 1fr; gap: 4vw; align-items: center; }
  .deck .split svg { width: 100%; height: auto; max-height: 78vh; }
  @media (max-width: 1000px) { .deck .split { grid-template-columns: 1fr; } }
  .deck .shot {
    background: var(--ink-800);
    border: 1px dashed var(--rule-2);
    border-radius: 14px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 42vh;
    margin: 0;
  }
  .deck .shot img {
    width: 100%;
    flex: 1;
    object-fit: cover;
    min-height: 0;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 18px;
    padding: 16px;
    box-sizing: border-box;
  }
  .deck .shot figcaption {
    font-family: var(--mono);
    font-size: 18px;
    color: var(--text-soft);
    padding: 12px 16px;
    border-top: 1px solid var(--rule);
  }
  .deck .caption { font-family: var(--mono); font-size: 22px; color: var(--text-faint); margin-top: 36px; }
  .deck .caption b { color: var(--mint); font-weight: 500; }
  .deck .closing {
    font-size: clamp(40px, 4.6vw, 72px);
    line-height: 1.15;
    letter-spacing: -0.015em;
    font-weight: 700;
    max-width: 24ch;
    margin-top: 12px;
  }
  .deck .node { fill: var(--ink-750); stroke: var(--rule-2); stroke-width: 2; }
  .deck .node-label { fill: var(--text); font-family: var(--mono); font-size: 23px; }
  .deck .arc { fill: none; stroke: var(--rule-2); stroke-width: 2.5; }
  .deck .gate { fill: var(--mint); }
  .deck .gate-label { fill: var(--mint); font-family: var(--mono); font-size: 17px; letter-spacing: 0.06em; }
  .deck .center-label { fill: var(--text-faint); font-family: var(--mono); font-size: 21px; }
  .deck-counter {
    position: fixed;
    right: 28px;
    bottom: 22px;
    font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
    font-size: 20px;
    color: #82949b;
    z-index: 10;
  }
  .deck-counter b { color: #00ff7f; font-weight: 500; }
  .deck-hint {
    position: fixed;
    left: 28px;
    bottom: 22px;
    font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
    font-size: 16px;
    color: #82949b;
    z-index: 10;
  }
`;

function LoopDiagram() {
  return (
    <svg
      viewBox="0 0 800 660"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="adloop pipeline: Scout, Strategist, Copywriter, Critic, Designer, Publisher, Analyst — a closed loop with three human gates"
    >
      <defs>
        <marker
          id="deck-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#29383e" />
        </marker>
      </defs>
      <path className="arc" markerEnd="url(#deck-arrow)" d="M 432 92 A 230 230 0 0 1 558 153" />
      <path className="arc" markerEnd="url(#deck-arrow)" d="M 598 203 A 230 230 0 0 1 629 339" />
      <path className="arc" markerEnd="url(#deck-arrow)" d="M 615 402 A 230 230 0 0 1 528 511" />
      <path className="arc" markerEnd="url(#deck-arrow)" d="M 470 539 A 230 230 0 0 1 330 539" />
      <path className="arc" markerEnd="url(#deck-arrow)" d="M 272 511 A 230 230 0 0 1 185 402" />
      <path className="arc" markerEnd="url(#deck-arrow)" d="M 171 339 A 230 230 0 0 1 202 203" />
      <path className="arc" markerEnd="url(#deck-arrow)" d="M 242 153 A 230 230 0 0 1 368 92" />
      <circle className="node" cx="400" cy="90" r="11" />
      <circle className="node" cx="580" cy="177" r="11" />
      <circle className="node" cx="624" cy="371" r="11" />
      <circle className="node" cx="500" cy="527" r="11" />
      <circle className="node" cx="300" cy="527" r="11" />
      <circle className="node" cx="176" cy="371" r="11" />
      <circle className="node" cx="220" cy="177" r="11" />
      <text className="node-label" x="400" y="58" textAnchor="middle">Scout</text>
      <text className="node-label" x="602" y="172">Strategist</text>
      <text className="node-label" x="646" y="378">Copywriter</text>
      <text className="node-label" x="514" y="560">Critic</text>
      <text className="node-label" x="286" y="560" textAnchor="end">Designer</text>
      <text className="node-label" x="154" y="378" textAnchor="end">Publisher</text>
      <text className="node-label" x="198" y="172" textAnchor="end">Analyst</text>
      <rect className="gate" x="616" y="261" width="16" height="16" transform="rotate(45 624 269)" />
      <rect className="gate" x="212" y="455" width="16" height="16" transform="rotate(45 220 463)" />
      <rect className="gate" x="168" y="261" width="16" height="16" transform="rotate(45 176 269)" />
      <text className="gate-label" x="648" y="265">HUMAN GATE</text>
      <text className="gate-label" x="648" y="286">angle approve</text>
      <text className="gate-label" x="196" y="486" textAnchor="end">HUMAN GATE</text>
      <text className="gate-label" x="196" y="507" textAnchor="end">asset approve</text>
      <text className="gate-label" x="152" y="245" textAnchor="end">HUMAN GATE</text>
      <text className="gate-label" x="152" y="266" textAnchor="end">activate ad</text>
      <text className="center-label" x="400" y="312" textAnchor="middle">spend &rarr; data</text>
      <text className="center-label" x="400" y="340" textAnchor="middle">&rarr; cheaper spend</text>
    </svg>
  );
}

const SLIDE_COUNT = 4;

export default function PitchPage() {
  const deckRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const currentRef = useRef(0);

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const slides = Array.from(deck.querySelectorAll("section"));

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const index = slides.indexOf(entry.target as HTMLElement);
            currentRef.current = index;
            setCurrent(index);
          }
        }
      },
      { threshold: 0.6 },
    );
    slides.forEach((s) => observer.observe(s));

    const go = (index: number) => {
      const next = Math.min(Math.max(index, 0), slides.length - 1);
      slides[next].scrollIntoView({ behavior: "smooth" });
    };

    const onKey = (e: KeyboardEvent) => {
      if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(e.key)) {
        e.preventDefault();
        go(currentRef.current + 1);
      } else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(e.key)) {
        e.preventDefault();
        go(currentRef.current - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        go(0);
      } else if (e.key === "End") {
        e.preventDefault();
        go(slides.length - 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <>
      <style>{css}</style>
      <div className="deck" ref={deckRef}>
        <section>
          <p className="kicker">01 &middot; The Problem</p>
          <h1>
            Paid ads are a <span className="dim">blind flight</span> for small teams.
          </h1>
          <div className="lines">
            <p>
              <strong>Agencies</strong> close the loop &mdash; at prices small teams can&rsquo;t
              pay.
            </p>
            <p>
              <strong>AI tools</strong> generate assets by the thousand &mdash; nobody tests them
              systematically.
            </p>
            <p className="punch">
              <strong>adloop</strong> &mdash; the ad engine that runs your paid ads as experiments.
            </p>
          </div>
        </section>

        <section>
          <p className="kicker">02 &middot; The Loop</p>
          <div className="split">
            <div>
              <h1>
                The machine tests.
                <br />
                <span className="mint">The human decides.</span>
              </h1>
              <div className="lines">
                <p>
                  Drop in a <strong>URL</strong>. Agents research the brand &mdash; website plus the
                  outside view.
                </p>
                <p>
                  <strong>Angle hypotheses</strong> &rarr; copy + critic &rarr; visuals. Testable,
                  not random.
                </p>
                <p>
                  Real <strong>Meta campaigns, published paused</strong> &mdash; a human flips every
                  switch.
                </p>
                <p className="punch">
                  Insights feed the next batch &mdash; <strong>cost per result falls</strong> loop
                  by loop.
                </p>
              </div>
            </div>
            <LoopDiagram />
          </div>
        </section>

        <section>
          <p className="kicker">03 &middot; Real, Today</p>
          <div className="split">
            <div>
              <h1>
                Not a mockup.
                <br />
                <span className="mint">Built today. Live now.</span>
              </h1>
              <div className="lines">
                <p>
                  A <strong>real paused campaign</strong> in a real Meta ad account &mdash;
                  published by the engine today.
                </p>
                <p>
                  <strong>Live app</strong> on Render &middot; <strong>open source</strong> (MIT) on
                  GitHub &middot; <strong>78 tests</strong> passing.
                </p>
                <p>
                  <strong>Chat-first Mission Control</strong> &mdash; every gate is one human click.
                </p>
              </div>
              <p className="caption">
                <b>Built with</b> Cursor &middot; fal.ai &middot; Firecrawl &middot; Render &middot;
                n8n &middot; ElevenLabs (roadmap)
              </p>
            </div>
            {/* data-src: drop screenshot at public/pitch-screenshots/ads-manager.png */}
            <figure className="shot">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/pitch-screenshots/ads-manager.png" alt="[ pitch-screenshots/ads-manager.png ]" />
              <figcaption>Meta Ads Manager &mdash; published by adloop, paused</figcaption>
            </figure>
          </div>
        </section>

        <section>
          <p className="kicker">04 &middot; Why Us</p>
          <h1>
            Tools are commoditized.
            <br />
            <span className="dim">Judgment isn&rsquo;t.</span>
          </h1>
          <div className="lines">
            <p>
              Everyone builds <strong>generators</strong>. We build the{" "}
              <strong>decision layer</strong> on top.
            </p>
            <p className="punch">
              Every small company gets a <strong>performance marketer</strong> &mdash; as an agent.
            </p>
          </div>
          <p className="closing">
            The machine tests. The human decides.{" "}
            <span className="mint mono">adloop-app.onrender.com</span>
          </p>
        </section>
      </div>
      <div className="deck-counter">
        <b>{current + 1}</b> / {SLIDE_COUNT}
      </div>
      <div className="deck-hint">&uarr;&darr; / &larr;&rarr; navigate</div>
    </>
  );
}

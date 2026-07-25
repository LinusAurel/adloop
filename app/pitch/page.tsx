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
  @media (max-height: 860px) {
    .deck h1 { font-size: clamp(38px, 5vw, 72px); margin-bottom: 24px; }
    .deck p { font-size: clamp(21px, 1.8vw, 28px); }
    .deck .kicker { font-size: 18px; margin-bottom: 18px; }
    .deck .closing { font-size: clamp(32px, 3.8vw, 56px); }
  }
  .deck .split { display: grid; grid-template-columns: 1.05fr 1fr; gap: 4vw; align-items: center; }
  .deck .split svg { width: 100%; height: auto; max-height: 78vh; }
  @media (max-width: 1000px) { .deck .split { grid-template-columns: 1fr; } }
  .deck .shots { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 8px 0 28px; }
  .deck .shots figure {
    background: var(--ink-800);
    border: 1px dashed var(--rule-2);
    border-radius: 14px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 30vh;
    margin: 0;
  }
  .deck .shots img {
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
  .deck .shots figcaption {
    font-family: var(--mono);
    font-size: 18px;
    color: var(--text-soft);
    padding: 12px 16px;
    border-top: 1px solid var(--rule);
  }
  .deck .caption { font-family: var(--mono); font-size: 22px; color: var(--text-faint); }
  .deck .caption b { color: var(--mint); font-weight: 500; }
  .deck .team { display: grid; gap: 10px; margin: 0 0 36px; max-width: 62ch; }
  .deck .team p { color: var(--text-soft); }
  .deck .team p strong { color: var(--text); }
  .deck .closing {
    font-size: clamp(40px, 4.6vw, 72px);
    line-height: 1.15;
    letter-spacing: -0.015em;
    font-weight: 700;
    max-width: 24ch;
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

const SLIDE_COUNT = 5;

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
            Everyone lives off paid ads.
            <br />
            <span className="dim">Nobody closes the loop.</span>
          </h1>
          <div className="lines">
            <p>
              <strong>Creators, brands, startups</strong> &mdash; testing creatives is manual or
              agency-priced.
            </p>
            <p>
              AI tools generate endless assets, but none feed <strong>performance data</strong> back
              into the next ad.
            </p>
            <p>
              <strong>Creative fatigue</strong> eats every campaign within weeks.
            </p>
            <p className="punch">
              We know firsthand &mdash; we&rsquo;re rebuilding our own company&rsquo;s customer
              acquisition from scratch.
            </p>
          </div>
        </section>

        <section>
          <p className="kicker">02 &middot; Your Solution</p>
          <div className="split">
            <div>
              <h1>adloop</h1>
              <div className="lines">
                <p>
                  <strong>The open-source agentic ads engine.</strong>
                </p>
                <p>
                  Plug in any company by URL. It researches, hypothesizes, creates, publishes{" "}
                  <strong>real Meta ads &mdash; paused</strong> &mdash; and mines the results.
                </p>
                <p className="punch">Every euro of ad spend makes the next one cheaper.</p>
              </div>
            </div>
            <LoopDiagram />
          </div>
        </section>

        <section>
          <p className="kicker">03 &middot; Sample Outputs</p>
          <div className="shots">
            {/* data-src: drop screenshot at public/pitch-screenshots/board.png */}
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/pitch-screenshots/board.png" alt="[ pitch-screenshots/board.png ]" />
              <figcaption>Mission Control &mdash; angle board</figcaption>
            </figure>
            {/* data-src: drop screenshot at public/pitch-screenshots/studio.png */}
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/pitch-screenshots/studio.png" alt="[ pitch-screenshots/studio.png ]" />
              <figcaption>Studio &mdash; static + critic score</figcaption>
            </figure>
            {/* data-src: drop screenshot at public/pitch-screenshots/economics.png */}
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/pitch-screenshots/economics.png" alt="[ pitch-screenshots/economics.png ]" />
              <figcaption>Economics &mdash; what the loop learned</figcaption>
            </figure>
            {/* data-src: drop screenshot at public/pitch-screenshots/ads-manager.png */}
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/pitch-screenshots/ads-manager.png" alt="[ pitch-screenshots/ads-manager.png ]" />
              <figcaption>Meta Ads Manager &mdash; published, paused</figcaption>
            </figure>
          </div>
          <p className="caption">
            <b>Real engine runs. Human approved.</b> Demo data labeled as such.
          </p>
        </section>

        <section>
          <p className="kicker">04 &middot; Go-to-Market</p>
          <h1>
            We <span className="mint">are</span> the customer.
          </h1>
          <div className="lines">
            <p>
              <strong>loyft GmbH goes live with adloop on Monday</strong> &mdash; our own acquisition
              runs on it.
            </p>
            <p>
              <strong>Open source as distribution</strong> &mdash; the engine is public, the
              learnings compound.
            </p>
            <p>
              <strong>Hosted version</strong> for creators and D2C brands next.
            </p>
            <p className="punch">
              The tool layer is commoditized &mdash; Meta ships it themselves. We build the judgment
              layer on top.
            </p>
          </div>
        </section>

        <section>
          <p className="kicker">05 &middot; Why You / Why Now</p>
          <div className="team">
            <p>
              <strong>Linus</strong> &mdash; founder, loyft GmbH. Builds agentic systems.
            </p>
            <p>
              <strong>Lenn</strong> &mdash; concept &amp; design.
            </p>
            <p>
              <strong>Why now:</strong> Meta&rsquo;s algorithm shift made creative diversity the only
              lever left &mdash; exactly what a machine produces better than manual workflows.
            </p>
          </div>
          <p className="closing">
            The machine tests. The human decides.{" "}
            <span className="mint">CAC goes down every week.</span>
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

import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import './ProjectScoped.css';
import './ProjectChat.css';

// AI — unified Generate + Automate surface. The Generate and Automate
// features used to be two separate sidebar entries; both are still
// placeholders, and merging them under a single "AI" entry with two
// tabs keeps the sidebar tight and signals to the user that "the AI
// stuff lives here". The tab styling is borrowed from ProjectChat
// (same `.project-chat-tabs` recipe) so the surface reads as a
// sibling of the chat's Team / Assistant tabs.

const GenerateIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
    <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z" />
    <path d="M5 4l.7 1.9L7.6 6.6 5.7 7.3 5 9.2 4.3 7.3 2.4 6.6l1.9-.7z" />
  </svg>
);

const AutomateIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

export default function ProjectAI() {
  const { selectedProject, loading } = useSelectedProject();
  const [tab, setTab] = useState('generate');

  // Sticky-tab pinned detection — mirrors the recipe in ProjectChat.
  // A 1 px sentinel above the bar lets an IntersectionObserver flip
  // the `is-stuck` class on the bar when it's pinned to the top of
  // the scroll viewport, so CSS can render at-rest (transparent,
  // in-frame) vs pinned (opaque, full-width) variants.
  const tabsSentinelRef = useRef(null);
  const [tabsStuck, setTabsStuck] = useState(false);
  useEffect(() => {
    const el = tabsSentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver(
      ([entry]) => setTabsStuck(entry.intersectionRatio < 1),
      { threshold: [0, 1] },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  if (loading && !selectedProject) {
    return <ProjectScopedSkeleton />;
  }

  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to use the AI tools.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  return (
    <div className="project-scoped-page">
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">AI</h1>
        <p className="project-scoped-subtitle">
          Generate documents and build workflows for <strong>{selectedProject.name}</strong>.
        </p>
      </header>
      {/* Tab bar hoisted out of the header so sticky positioning
          (defined in ProjectChat.css under .project-chat-tabs) has a
          tall-enough containing block to pin against. The 1 px
          sentinel above lets an IntersectionObserver flip the
          `is-stuck` class for the pinned visual state. */}
      <div className="project-chat-tabs-sentinel" ref={tabsSentinelRef} aria-hidden="true" />
      <div
        className={`project-chat-tabs${tabsStuck ? ' is-stuck' : ''}`}
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'generate'}
          className={`project-chat-tab${tab === 'generate' ? ' is-active' : ''}`}
          onClick={() => setTab('generate')}
        >
          {GenerateIcon} <span>Generate</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'automate'}
          className={`project-chat-tab${tab === 'automate' ? ' is-active' : ''}`}
          onClick={() => setTab('automate')}
        >
          {AutomateIcon} <span>Automate</span>
        </button>
      </div>

      {tab === 'generate' && (
        <section className="project-scoped-coming-soon">
          <h2>AI document generation coming next</h2>
          <p>
            Generate briefs, motions, and client letters from the project's
            existing files — templates, prompts, and the per-project model
            context ship in a later build.
          </p>
        </section>
      )}

      {tab === 'automate' && (
        <section className="project-scoped-coming-soon">
          <h2>Per-project automation coming next</h2>
          <p>
            Build "when X happens, do Y" workflows for this project — auto-tag
            uploaded files, ping the team when deadlines approach, route
            incoming documents to the right folder. The triggers/actions
            schema ships in a later build.
          </p>
        </section>
      )}
    </div>
  );
}

import { FormEvent, useEffect, useMemo, useState } from 'react';

type GuestOption = {
  value: string;
  top: string;
  bottom?: string;
  icon?: 'people';
};

const guestOptions: GuestOption[] = [
  { value: '10-25', top: '10–25', bottom: 'Guests' },
  { value: '26-50', top: '26–50', bottom: 'Guests' },
  { value: '51-100', top: '51–100', bottom: 'Guests' },
  { value: '101-200', top: '101–200', bottom: 'Guests' },
  { value: '201+', top: '201+', bottom: 'Guests' },
  { value: 'not-sure', top: 'Not sure yet', icon: 'people' },
];

function FlameIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M13.7 2.7c.5 3-1 4.5-2.1 5.8-1.2 1.4-2.1 2.5-1.4 4.4.4-1.1 1.1-1.9 2.2-2.8-.1 2.6 2.1 3.5 2.1 6.2 0 2-1.2 3.6-3.1 4.2-3.7 1.2-7.4-1.6-7.4-5.4 0-3.1 1.8-5 3.7-7.1.1 2 .8 3.2 1.6 4-.5-3.7 2.3-5.1 4.4-9.3Z"
        fill="currentColor"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function LeafIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19.5 4.5C12 4.8 6.1 8 5 14.4c-.4 2.6 1.2 4.6 3.8 4.6 6 0 9.3-6.4 10.7-14.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M5.5 19c2.3-4.2 5.3-6.8 9.2-8.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 19v-1.2c0-2.5 2.2-4.3 5-4.3s5 1.8 5 4.3V19m0-4.2c.7-.5 1.6-.8 2.6-.8 2.5 0 4.4 1.5 4.4 3.6V19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 7.5V12l3.2 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="10" width="11" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9 10V7.5a3 3 0 0 1 6 0V10" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BBQMobileScreen() {
  const goldenPreview = useMemo(
    () => new URLSearchParams(window.location.search).get('preview') === 'golden',
    [],
  );
  const [selected, setSelected] = useState<string | null>(goldenPreview ? '10-25' : null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    document.title = 'BBQ Catering in Portland | Gourmet Corp';
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setAnnouncement('Guest count saved. The next funnel step is being built.');
  }

  return (
    <main className="mobile-stage">
      <div className="mobile-app">
        <header className="brand-header">
          <div className="brand-lockup" aria-label="Gourmet Corp">
            <span className="brand-mark"><FlameIcon /></span>
            <span className="brand-words">
              <strong>GOURMET CORP</strong>
              <small>FOOD BRINGS PEOPLE TOGETHER</small>
            </span>
          </div>
          <button className="menu-button" type="button" aria-label="Open menu">
            <MenuIcon />
          </button>
        </header>

        <section className="bbq-hero" aria-labelledby="bbq-title">
          <div className="hero-content">
            <p className="hero-eyebrow">BBQ CATERING · PORTLAND</p>
            <h1 id="bbq-title">BBQ Catering<br />in Portland</h1>
            <p className="hero-copy">
              Amazing food. Unforgettable events. Get a personalized quote in under 2 minutes.
            </p>
            <div className="hero-features" aria-label="Service highlights">
              <span><i><LeafIcon /></i>Local<br />team</span>
              <span><i><PeopleIcon /></i>Events of<br />any size</span>
              <span><i><StarIcon /></i>Custom<br />menus</span>
            </div>
          </div>
        </section>

        <section className="quote-panel" aria-labelledby="guest-question">
          <div className="progress-row">
            <div className="progress-left">
              <strong>Step 1 of 4</strong>
              <div className="progress-track" role="progressbar" aria-label="Quote progress" aria-valuemin={0} aria-valuemax={4} aria-valuenow={1}>
                <span />
              </div>
            </div>
            <div className="event-time">
              <ClockIcon />
              <span><strong>Your Event</strong><small>1–2 min</small></span>
            </div>
          </div>

          <form onSubmit={submit}>
            <fieldset>
              <legend id="guest-question">How many guests are you catering for?</legend>
              <p className="question-help">This helps us create an accurate quote for you.</p>

              <div className="guest-grid">
                {guestOptions.map((option) => {
                  const active = selected === option.value;
                  return (
                    <label className={`guest-option${active ? ' is-selected' : ''}`} key={option.value}>
                      <input
                        type="radio"
                        name="guest-count"
                        value={option.value}
                        checked={active}
                        onChange={() => setSelected(option.value)}
                      />
                      {option.icon && <span className="guest-option-icon"><PeopleIcon /></span>}
                      <span className="guest-option-copy">
                        <strong>{option.top}</strong>
                        {option.bottom && <small>{option.bottom}</small>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="local-proof" aria-label="Local service information">
              <span className="proof-icon"><PeopleIcon /></span>
              <span className="proof-copy">
                <strong>Serving Portland-area events</strong>
                <small>Check availability in under 2 minutes</small>
              </span>
              <span className="proof-chevron">›</span>
            </div>

            <button className="continue-button" type="submit" disabled={!selected}>
              <span>Continue</span>
              <ArrowIcon />
            </button>

            <p className="privacy-note"><LockIcon />Your information is secure and never shared.</p>
            <p className="sr-only" aria-live="polite">{announcement}</p>
          </form>
        </section>
      </div>
    </main>
  );
}

function FoundationScreen() {
  return (
    <main className="shell">
      <section className="card" aria-labelledby="page-title">
        <p className="eyebrow">GOURMET CORPORATION</p>
        <h1 id="page-title">Growth Form V2</h1>
        <p className="lede">
          Mobile-first staging foundation is running. Open <code>/form2/bbq/</code> for the first M0 screen.
        </p>
        <div className="status">
          <span className="dot" aria-hidden="true" />
          Foundation ready
        </div>
      </section>
    </main>
  );
}

export default function App() {
  return window.location.pathname.includes('/bbq') ? <BBQMobileScreen /> : <FoundationScreen />;
}

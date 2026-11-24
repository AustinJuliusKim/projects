import { useState, type FormEvent } from "react";
import Nav from "../components/Nav";
import Footer from "../components/Footer";
import { profile } from "../data";
import { STUDIO_NAME, CHECKLIST_HREF, studioCopy } from "../studio";
import "./studio.css";

const BUSINESS_TYPES = [
  ["restaurant", "Restaurant or food business"],
  ["salon-booking", "Salon or appointment-based"],
  ["retail", "Retail shop"],
  ["professional-office", "Professional office"],
  ["other", "Something else"],
] as const;

const CITIES = [
  ["glendale", "Glendale"],
  ["pasadena", "Pasadena"],
  ["burbank", "Burbank"],
  ["sfv", "San Fernando Valley"],
  ["la-other", "Elsewhere in Los Angeles"],
  ["other", "Somewhere else"],
] as const;

const FIELDS = ["email", "firstName", "businessType", "businessName", "website", "city", "consent"] as const;
type Field = (typeof FIELDS)[number];
type Errors = Partial<Record<Field | "form", string>>;
type Status = "idle" | "sending" | "done" | "done-offline" | "error";

const REQUIRED_MSG: Record<string, string> = {
  email: "Enter a valid email address.",
  firstName: "Enter your first name.",
  businessType: "Pick the closest business type.",
  businessName: "Enter your business name.",
  city: "Pick your city.",
  consent: "Please check this box so I can email you the checklist.",
};

function validate(v: Record<string, string | boolean>): Errors {
  const e: Errors = {};
  const s = (k: string) => String(v[k] ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s("email"))) e.email = REQUIRED_MSG.email;
  for (const k of ["firstName", "businessType", "businessName", "city"] as const) {
    if (!s(k)) e[k] = REQUIRED_MSG[k];
  }
  if (!v.consent) e.consent = REQUIRED_MSG.consent;
  return e;
}

function utmFromLocation(): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(window.location.search).forEach((val, key) => {
    if (key.startsWith("utm_")) out[key] = val;
  });
  return out;
}

const mailto = `mailto:${profile.email}?subject=${encodeURIComponent("Small business tech checklist")}`;

function FieldError({ id, msg }: { id: string; msg?: string }) {
  return msg ? (
    <p className="st-error" id={`${id}-err`}>
      {msg}
    </p>
  ) : null;
}

function LeadForm() {
  const [errors, setErrors] = useState<Errors>({});
  const [status, setStatus] = useState<Status>("idle");

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (status === "sending") return;
    const fd = new FormData(ev.currentTarget);
    const v: Record<string, string | boolean> = {};
    for (const k of [...FIELDS, "company"]) v[k] = k === "consent" ? fd.get(k) === "on" : String(fd.get(k) ?? "");
    const errs = validate(v);
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = FIELDS.find((k) => errs[k]);
      if (first) ev.currentTarget.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }

    const base = (import.meta.env.VITE_LEADS_API_URL ?? "").trim().replace(/\/+$/, "");
    if (!base) {
      setStatus("done-offline");
      return;
    }

    setStatus("sending");
    try {
      const res = await fetch(`${base}/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(v.email).trim(),
          firstName: String(v.firstName).trim(),
          businessType: v.businessType,
          businessName: String(v.businessName).trim(),
          website: String(v.website).trim(),
          city: v.city,
          consent: true,
          company: v.company,
          utm: utmFromLocation(),
        }),
      });
      if (res.ok) {
        setStatus("done");
        return;
      }
      if (res.status === 400) {
        const data = await res.json().catch(() => null);
        const fields = data && typeof data.fields === "object" && data.fields ? data.fields : null;
        if (fields) {
          const next: Errors = {};
          for (const k of FIELDS) if (fields[k]) next[k] = String(fields[k]);
          if (Object.keys(next).length) {
            setErrors(next);
            setStatus("idle");
            return;
          }
        }
      }
      setErrors({ form: "generic" });
      setStatus("error");
    } catch {
      setErrors({ form: "generic" });
      setStatus("error");
    }
  }

  if (status === "done" || status === "done-offline") {
    return (
      <div className="st-success" role="status">
        <h3>Here is your checklist.</h3>
        <p>
          <a className="btn primary" data-testid="checklist-download" href={CHECKLIST_HREF} download>
            Download the checklist (PDF)
          </a>
        </p>
        {status === "done" ? (
          <p>I will also send a copy, so check your inbox (and spam folder) in a few minutes.</p>
        ) : (
          <p>
            Questions, or want a copy by email? <a href={mailto}>Email me</a>.
          </p>
        )}
      </div>
    );
  }

  const d = (k: Field) => (errors[k] ? { "aria-invalid": true, "aria-describedby": `${k}-err` } : {});

  return (
    <form id="lead-form" noValidate onSubmit={onSubmit} className="st-form">
      <div className="st-field">
        <label htmlFor="f-firstName">First name</label>
        <input id="f-firstName" name="firstName" autoComplete="given-name" required {...d("firstName")} />
        <FieldError id="firstName" msg={errors.firstName} />
      </div>
      <div className="st-field">
        <label htmlFor="f-email">Email</label>
        <input id="f-email" name="email" type="email" autoComplete="email" required {...d("email")} />
        <FieldError id="email" msg={errors.email} />
      </div>
      <div className="st-field">
        <label htmlFor="f-businessName">Business name</label>
        <input id="f-businessName" name="businessName" autoComplete="organization" required {...d("businessName")} />
        <FieldError id="businessName" msg={errors.businessName} />
      </div>
      <div className="st-field">
        <label htmlFor="f-businessType">Type of business</label>
        <select id="f-businessType" name="businessType" defaultValue="" required {...d("businessType")}>
          <option value=""></option>
          {BUSINESS_TYPES.map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>
        <FieldError id="businessType" msg={errors.businessType} />
      </div>
      <div className="st-field">
        <label htmlFor="f-city">City</label>
        <select id="f-city" name="city" defaultValue="" required {...d("city")}>
          <option value=""></option>
          {CITIES.map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>
        <FieldError id="city" msg={errors.city} />
      </div>
      <div className="st-field">
        <label htmlFor="f-website">
          Website <span className="st-opt">(optional)</span>
        </label>
        <input id="f-website" name="website" type="text" inputMode="url" autoComplete="url" {...d("website")} />
        <FieldError id="website" msg={errors.website} />
      </div>

      <div className="st-hp" aria-hidden="true">
        <label htmlFor="f-company">Company</label>
        <input id="f-company" name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="st-field st-consent">
        <input id="f-consent" name="consent" type="checkbox" required {...d("consent")} />
        <label htmlFor="f-consent">
          Email me the checklist and occasional tips. Unsubscribe anytime. <a href="#privacy">Privacy</a>
        </label>
        <FieldError id="consent" msg={errors.consent} />
      </div>

      <div aria-live="polite" className="st-status">
        {status === "sending" && <p>Sending...</p>}
        {errors.form && (
          <p className="st-error">
            Something went wrong on my end. Please try again, or <a href={mailto}>email me</a> and I will send the checklist
            directly.
          </p>
        )}
        {Object.keys(errors).some((k) => k !== "form") && <p className="st-error">Please fix the highlighted fields.</p>}
      </div>

      <button className="btn primary" type="submit" disabled={status === "sending"}>
        Send me the checklist
      </button>
    </form>
  );
}

function FormCard({ id }: { id?: string }) {
  return (
    <div className="st-card" id={id}>
      <h2 className="st-card-h">Get the free small business tech checklist</h2>
      <p className="st-muted">One page of plain-English checks for your website, Wi-Fi and security. Takes about 10 minutes.</p>
      <LeadForm />
    </div>
  );
}

export default function Studio() {
  const c = studioCopy;
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav />
      <main id="main" className="studio">
        <header className="st-hero">
          <div className="wrap">
            <p className="eyebrow">{STUDIO_NAME}</p>
            <h1>{c.h1}</h1>
            <p className="lede">{c.lede}</p>
            <div className="cta-row">
              <a className="btn primary" href="#lead-form">
                Get the free checklist
              </a>
              <a className="btn" href="#how">
                How it works
              </a>
            </div>
          </div>
        </header>

        <section aria-labelledby="form-h" className="st-form-section">
          <div className="wrap">
            <span id="form-h" hidden>
              Free checklist signup
            </span>
            <FormCard />
          </div>
        </section>

        <section aria-labelledby="pillars-h">
          <div className="wrap">
            <p className="eyebrow">What I do</p>
            <h2 id="pillars-h" className="st-h2">
              Three things small businesses need to get right.
            </h2>
            <div className="st-pillars">
              {c.pillars.map((p) => (
                <article key={p.id} className="st-pillar">
                  <h3>{p.title}</h3>
                  <p className="st-sum">{p.summary}</p>
                  <ul>
                    {p.points.map((pt) => (
                      <li key={pt}>{pt}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how" aria-labelledby="how-h">
          <div className="wrap">
            <p className="eyebrow">How it works</p>
            <h2 id="how-h" className="st-h2">
              Four steps, no surprises.
            </h2>
            <ol className="st-steps">
              <li>
                <strong>Take the checklist.</strong> See where you stand in about 10 minutes.
              </li>
              <li>
                <strong>Free 20-minute call.</strong> We talk through what matters for your business. No pitch deck.
              </li>
              <li>
                <strong>Fixed-price quote.</strong> You know the cost before I start.
              </li>
              <li>
                <strong>Monthly care plan.</strong> Optional. I keep things updated, backed up and working.
              </li>
            </ol>
          </div>
        </section>

        <section aria-labelledby="why-h">
          <div className="wrap">
            <p className="eyebrow">Why me</p>
            <h2 id="why-h" className="st-h2">
              A working engineer, not an agency.
            </h2>
            <p>
              I am Austin Kim, a senior software engineer with nine years of shipping production web software. You work
              with me directly, from the first call to the follow-up. I live and work in the Glendale area, so I can come
              to your shop or office when it helps.
            </p>
            <p>
              Glendale-area family businesses are my neighbors, and I am happy to work in whatever way is most
              comfortable for you and your staff.
            </p>
          </div>
        </section>

        <section aria-labelledby="faq-h">
          <div className="wrap">
            <p className="eyebrow">FAQ</p>
            <h2 id="faq-h" className="st-h2">
              Common questions.
            </h2>
            <div className="st-faq">
              <details>
                <summary>What does it cost?</summary>
                <p>
                  Every project gets a fixed price in writing before work starts. Care plans are a flat monthly fee. The
                  20-minute call and the checklist are free.
                </p>
              </details>
              <details>
                <summary>Do I need to be technical?</summary>
                <p>No. I explain things in plain English and handle the setup. You tell me how your business runs.</p>
              </details>
              <details>
                <summary>Will you use an accessibility overlay widget?</summary>
                <p>
                  No. Overlays do not fix the underlying problems and do not protect you from complaints. I build sites to
                  WCAG 2.1 AA from the start, which is what reduces legal risk and helps real customers.
                </p>
              </details>
              <details>
                <summary>Which areas do you serve?</summary>
                <p>
                  Glendale, Pasadena, Burbank and the San Fernando Valley, in person. Web work can be done remotely for
                  anyone in the Los Angeles area.
                </p>
              </details>
            </div>
          </div>
        </section>

        <section aria-labelledby="cta-h">
          <div className="wrap">
            <h2 id="cta-h" className="st-h2">
              Start with the checklist.
            </h2>
            <p className="st-muted">It is free, and it will show you the three or four things worth fixing first.</p>
            <div className="cta-row">
              <a className="btn primary" href="#lead-form">
                Get the free checklist
              </a>
            </div>
          </div>
        </section>

        <section id="privacy" aria-labelledby="privacy-h" className="st-privacy">
          <div className="wrap">
            <h2 id="privacy-h" className="st-h2">
              Privacy
            </h2>
            <ul>
              <li>
                <strong>What I collect:</strong> the details you enter in the form, plus campaign tags (utm values) from the
                link you came from.
              </li>
              <li>
                <strong>Why:</strong> to send you the checklist, reply to you, and occasionally email tips. Nothing else.
              </li>
              <li>
                <strong>Not sold.</strong> I do not sell or share your information with third parties for marketing.
              </li>
              <li>
                <strong>Delete it:</strong> email <a href={`mailto:${profile.email}`}>{profile.email}</a> and I will delete
                your data. You can also unsubscribe from any email. California residents can request access to or deletion of
                their data under the CCPA.
              </li>
            </ul>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

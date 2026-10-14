import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Mail, Section } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy policy — aderugy.fr",
  description: "What aderugy.fr collects, why, who processes it, and your rights.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      intro={
        <p>
          aderugy.fr is a personal website with a few utility tools (agenda, jobs, maths, poker).
          This page explains which personal data it handles, why, where it goes, and how you can
          control it. The short version: only what the tools need to work, no advertising, nothing
          sold, and you can ask for everything to be deleted at any time.
        </p>
      }
    >
      <Section title="1. Who is responsible">
        <p>
          The data controller is Arthur Goullet de Rugy, an individual running this site as a
          personal, non-commercial project. For any question or request about your data,
          write to <Mail />.
        </p>
      </Section>

      <Section title="2. What is collected">
        <p>
          <strong>Without an account.</strong> The pot-odds calculator on <code>/poker</code> works
          without signing in and stores nothing on the server. The rake preset you pick is kept in
          your browser&apos;s local storage and never leaves your device.
        </p>
        <p>
          <strong>Your account.</strong> Signing in uses Google. The site receives the identity
          Google shares at sign-in — your name, email address, profile picture and Google account
          identifier — and keeps a session in cookies that are strictly necessary for you to stay
          signed in.
        </p>
        <p>
          <strong>What you enter in the tools.</strong> Everything you create is stored in your
          account: agenda tasks, categories, blocks, weeks and objectives; maths progress, exercise
          results and review history; job applications, companies, notes, saved copies of job
          offers and interviews; live poker sessions, hands, players and notes; poker spots and
          trainers.
        </p>
        <p>
          <strong>Google Calendar (optional).</strong> Only if you connect it from the agenda
          settings, in a separate consent from sign-in:
        </p>
        <ul>
          <li>
            <strong>Read-only access to your calendars</strong> (<code>calendar.readonly</code>): the
            list of your calendars and their events (title, times, all-day flag, availability and
            your response status) is mirrored so your commitments appear on the agenda grid. Your
            existing calendars are never modified.
          </li>
          <li>
            <strong>Calendars created by the app</strong> (<code>calendar.app.created</code>): if you
            turn on pushing, the site creates an &ldquo;Agenda&rdquo; calendar in your Google account
            and writes your planned blocks to it. It can write to that calendar only.
          </li>
        </ul>
        <p>
          The Google access tokens are stored encrypted (Supabase Vault) and are used only by the
          server functions that synchronise calendars; they never reach the browser.
        </p>
        <p>
          <strong>Connected apps (optional).</strong> If you authorise an app such as Claude to
          access your account, it receives a token that lets it read and edit your data in the
          tools it was granted (agenda, jobs, live poker). You can see and revoke these grants in the
          agenda settings. Data the app reads is then also handled under that app&apos;s own privacy
          policy.
        </p>
        <p>
          <strong>Notifications (optional).</strong> If you turn on block reminders on a device, the
          site stores that device&apos;s push subscription (an endpoint address and encryption keys)
          and a record of which reminders were sent.
        </p>
        <p>
          <strong>Job-offer links.</strong> When you add a link to an application, the server
          downloads that public page once to save a copy of the offer. The request comes from the
          server, not from your browser.
        </p>
        <p>
          <strong>Technical data.</strong> Vercel Web Analytics and Speed Insights measure page
          views and loading performance in aggregate, without cookies and without identifying you.
          The hosting providers keep standard server logs (such as IP address and request time) for
          security and operation.
        </p>
      </Section>

      <Section title="3. Why, and on what legal basis">
        <ul>
          <li>
            <strong>Providing the tools you use</strong> — your account and everything you enter:
            necessary to provide the service you asked for (GDPR art. 6(1)(b)).
          </li>
          <li>
            <strong>Google Calendar, connected apps and notifications</strong>: your consent (art.
            6(1)(a)), which you can withdraw at any time by disconnecting or turning them off.
          </li>
          <li>
            <strong>Security, backups and aggregate statistics</strong>: the legitimate interest of
            keeping the site working, safe and recoverable (art. 6(1)(f)).
          </li>
        </ul>
        <p>
          Your data is never sold, never used for advertising, and never used to build a profile of
          you for anyone else.
        </p>
      </Section>

      <Section title="4. Google user data">
        <p>
          aderugy.fr&apos;s use and transfer of information received from Google APIs adheres to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. Google data is used only to show your calendars
          on your own agenda and to write your blocks to the calendar the app created. It is not
          transferred to anyone except as needed to provide that feature, not used for advertising,
          not read by a human unless you ask for help with your account or the law requires it, and
          not used to train AI models.
        </p>
      </Section>

      <Section title="5. Who processes it">
        <p>The site relies on a few service providers, each acting on its behalf:</p>
        <ul>
          <li>
            <strong>Supabase</strong> — database, authentication and server functions, hosted in the
            European Union (Ireland).
          </li>
          <li>
            <strong>Vercel</strong> — website hosting and aggregate analytics. Vercel may process
            requests outside the EU; such transfers rely on the European Commission&apos;s standard
            contractual clauses or the EU–US Data Privacy Framework.
          </li>
          <li>
            <strong>Google</strong> — sign-in, and Google Calendar if you connect it. Database
            backups are also stored in the site owner&apos;s Google Drive.
          </li>
          <li>
            <strong>Your browser&apos;s push service</strong> (for example Google, Apple or Mozilla)
            — delivers notifications if you turn them on. The content is encrypted end to end.
          </li>
          <li>
            <strong>jsDelivr</strong> — serves the Python runtime when you run code in a maths
            exercise; your browser downloads it directly.
          </li>
        </ul>
      </Section>

      <Section title="6. Information about other people">
        <p>
          Some tools let you write about other people — poker players you met at a table, contacts
          at a company. You are responsible for that information: keep it factual, limited to what
          you need, and respectful of their privacy. A person you wrote about can contact the site
          owner to have it removed.
        </p>
      </Section>

      <Section title="7. How long it is kept">
        <ul>
          <li>Your account and content: for as long as you keep your account.</li>
          <li>
            Google Calendar data: while the connection is active. Disconnecting stops all
            synchronisation and deletes the &ldquo;Agenda&rdquo; calendar from Google.
          </li>
          <li>Push subscriptions: until you turn reminders off on that device or it expires.</li>
          <li>
            Backups: the 30 most recent are kept; older ones are deleted, so deleted data disappears
            from backups after they rotate.
          </li>
        </ul>
        <p>
          To delete your account and everything in it, write to <Mail />. It is done within 30 days.
        </p>
      </Section>

      <Section title="8. Security">
        <p>
          Every connection is encrypted (HTTPS). In the database, each row is tied to its owner and
          protected by row-level security, so one account cannot read another&apos;s data. Secrets
          such as Google tokens are kept encrypted and are only reachable by the server functions
          that need them.
        </p>
      </Section>

      <Section title="9. Your rights">
        <p>
          Under the GDPR and the French Data Protection Act you can access your data, correct it,
          have it deleted, receive it in a portable format, restrict or object to its processing,
          withdraw your consent at any time, and give instructions about what happens to it after
          your death. Write to <Mail />; you will get an answer within one month.
        </p>
        <p>
          If you think your rights are not respected, you can complain to the CNIL (
          <a href="https://www.cnil.fr">cnil.fr</a>) or to your own country&apos;s data protection
          authority.
        </p>
      </Section>

      <Section title="10. Children">
        <p>The tools are not meant for anyone under 15, and no account should be created for them.</p>
      </Section>

      <Section title="11. Changes">
        <p>
          If this policy changes, the date at the top changes with it; significant changes are
          announced on the site. See also the <Link href="/terms">terms of use</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}

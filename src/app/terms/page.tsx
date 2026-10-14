import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, Mail, Section } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of use — aderugy.fr",
  description: "The rules for using aderugy.fr and its tools.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      intro={
        <p>
          These terms govern your use of aderugy.fr and its tools. By using the site — and in
          particular by signing in — you accept them. If you do not, please do not use the site.
        </p>
      }
    >
      <Section title="1. Publisher and host">
        <p>
          The site is published by Arthur Goullet de Rugy, an individual, as a personal and
          non-commercial project. Contact: <Mail />.
        </p>
        <p>
          It is hosted by Vercel Inc., 440 N Barranca Ave #4133, Covina, CA 91723, United States
          (vercel.com). Its database is hosted by Supabase in the European Union.
        </p>
      </Section>

      <Section title="2. The service">
        <p>
          aderugy.fr offers free tools: a weekly planner (<code>/agenda</code>), an internship search
          tracker (<code>/jobs</code>), a probability and statistics course (<code>/maths</code>), a
          poker odds calculator and live session tracker (<code>/poker</code>). Some can be used
          without an account; the others need one.
        </p>
        <p>
          The site is provided as it is and as available. Features can change, be paused or be
          removed at any time, and no particular availability is guaranteed. If a tool you rely on
          is going away, reasonable notice will be given so you can ask for a copy of your data.
        </p>
      </Section>

      <Section title="3. Your account">
        <p>
          You sign in with your Google account. You are responsible for what happens under your
          account and for keeping your Google account secure. You must be at least 15 years old to
          create an account.
        </p>
        <p>
          You can stop using the site at any time and ask for your account and all its data to be
          deleted by writing to <Mail />.
        </p>
      </Section>

      <Section title="4. Your content">
        <p>
          What you enter — tasks, notes, applications, hands, players and so on — remains yours. You
          allow the site to store, process and display it only as needed to provide the tools to
          you, including to the services you choose to connect (such as Google Calendar or Claude).
        </p>
        <p>
          You are responsible for that content and must have the right to enter it. When it
          concerns other people (players you met, contacts at a company), keep it factual, limited
          to what you need, and respectful of their privacy. Content that is unlawful, defamatory or
          infringes someone&apos;s rights is not allowed and may be removed.
        </p>
      </Section>

      <Section title="5. Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>attempt to access accounts or data that are not yours, or to bypass security measures;</li>
          <li>
            overload, disrupt or probe the site, its API or its connector, including through
            automated requests beyond normal use;
          </li>
          <li>
            use the job-offer link feature to make the server fetch anything other than a job offer
            for your own applications;
          </li>
          <li>use the site for any unlawful purpose.</li>
        </ul>
        <p>Accounts that break these rules can be suspended or deleted.</p>
      </Section>

      <Section title="6. Connected services">
        <p>
          Google sign-in, Google Calendar and apps you connect (such as Claude) are provided by third
          parties under their own terms and privacy policies. You can disconnect them at any time
          from the agenda settings.
        </p>
      </Section>

      <Section title="7. Information only — no advice">
        <p>
          The tools are aids for study and organisation. The poker calculator, solver views and
          trackers do not constitute gambling, financial or professional advice, and the maths
          course carries no guarantee of being free of errors. Decisions you take with them are
          yours.
        </p>
        <p>
          Gambling involves the risk of losing money and can become addictive. Gambling is
          forbidden to minors. If you need help, in France you can call Joueurs Info Service on
          09 74 75 13 13 (free call) or visit{" "}
          <a href="https://www.joueurs-info-service.fr">joueurs-info-service.fr</a>.
        </p>
      </Section>

      <Section title="8. Intellectual property">
        <p>
          The site&apos;s design, texts and course content belong to their author unless stated
          otherwise. Where source code is published under an open-source licence, that licence
          applies to the code.
        </p>
      </Section>

      <Section title="9. Liability">
        <p>
          The site is a free personal project. To the extent permitted by law, its publisher is not
          liable for indirect damage, for loss of data or for any consequence of decisions taken
          using the tools, and does not guarantee that the site is free of errors or always
          available. Keep your own copy of anything you cannot afford to lose. Nothing in these terms
          limits liability that cannot be limited by law, nor your rights as a consumer.
        </p>
      </Section>

      <Section title="10. Personal data">
        <p>
          How your data is handled is described in the{" "}
          <Link href="/privacy">privacy policy</Link>, which is part of these terms.
        </p>
      </Section>

      <Section title="11. Changes">
        <p>
          These terms may be updated; the date at the top shows the current version, and
          significant changes are announced on the site. Continuing to use the site after a change
          means you accept the new terms.
        </p>
      </Section>

      <Section title="12. Governing law">
        <p>
          These terms are governed by French law. In case of a dispute, please write first to{" "}
          <Mail /> so it can be settled amicably; failing that, the competent French courts have
          jurisdiction, without depriving a consumer of the protection of the mandatory rules of
          their country of residence.
        </p>
      </Section>
    </LegalPage>
  );
}

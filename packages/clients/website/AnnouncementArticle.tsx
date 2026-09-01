import collaborationAsset from "./announcement-collaboration.webp";
import sessionsAsset from "./announcement-sessions.webp";
import automationsAsset from "./announcement-automations.webp";
import deskAsset from "./announcement-desk.webp";
import walkthroughsAsset from "./announcement-walkthroughs.webp";
import { assetUrl } from "./asset-url";
import { ProductDemo } from "./ProductDemo";

const featureShots = {
  collaboration: assetUrl(collaborationAsset),
  sessions: assetUrl(sessionsAsset),
  automations: assetUrl(automationsAsset),
  desk: assetUrl(deskAsset),
  walkthroughs: assetUrl(walkthroughsAsset),
};

function AnnouncementFeatureShot({
  feature,
  alt,
}: {
  feature: keyof typeof featureShots;
  alt: string;
}) {
  return (
    <figure
      className={`announcement-feature-shot announcement-feature-${feature}`}
    >
      <img
        src={featureShots[feature]}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    </figure>
  );
}

export function AnnouncementArticle({
  showMark = false,
  showDemo = false,
}: {
  showMark?: boolean;
  showDemo?: boolean;
}) {
  return (
    <article className="announcement-article">
      {showMark && (
        <img className="announcement-page-mark" src="/icon.png" alt="" />
      )}
      <h1 id="announcement-title">Introducing Open Session</h1>

      <p>
        Open Session is an open-source cloud-based agent orchestrator. It has
        everything your team needs to ship, analyze, and talk to customers. It
        runs in your browser, on Mac, and on Windows. iOS is coming soon.
      </p>

      <p>
        Open Session was built by{" "}
        <a
          className="announcement-inline-link"
          href="https://tella.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          Tella
        </a>
        . We wanted an orchestrator that fit our team’s exact needs. We found
        existing apps to be either the wrong fit or too expensive. It’s also
        just fun to build your own tools.
      </p>

      {showDemo && (
        <div className="stage announcement-article-demo">
          <ProductDemo />
        </div>
      )}

      <p>
        We could just keep Open Session for ourselves but we’re open-sourcing it
        because we believe:
      </p>

      <ol>
        <li>Every company is going to work like this</li>
        <li>
          Teams can and <em>should</em> own their tooling
        </li>
        <li>Agent orchestration revolves around a common set of tooling</li>
      </ol>

      <p>
        Everyone uses Open Session at Tella, and not just for product
        development either. Open Session helps us with operations, support, data
        analysis, finance, and general AI chat.
      </p>

      <p>
        Since July, 80% of code shipped to Tella has come from Open Session.
        It’s become the most important tool that our team uses.
      </p>

      <h2>How does it work</h2>

      <p>
        Open Session is a self-hosted web app that uses the Pi agent engine. Pi
        connects sessions to different model providers, while Open Session
        manages conversations, Git worktrees, PRs, automations, and execution
        that you can run on your own machines or in sandboxes.
      </p>

      <p>
        Because it’s open source, you can fork it and fully adapt it to your
        company. But Open Session is also extensible at the product layer. You
        can connect MCPs, skills, automation recipes, integrations, sandbox
        providers and more.
      </p>

      <p>
        You can also configure branding, identity, repositories, and company
        routines without maintaining a fork.
      </p>

      <h2>Sessions</h2>

      <p>
        Open Session’s most important concept is the session. They’re durable,
        steerable conversations with an agent that have their own transcript,
        model, execution context, prompt queue, and visible state.
      </p>

      <p>
        Code sessions run in an isolated Git worktree and can edit files, run
        tests, and open a PR. Ask sessions are read-only and work great for
        research, planning, or codebase Q&amp;A.
      </p>

      <AnnouncementFeatureShot
        feature="sessions"
        alt="A Tella code session comparing waveform treatments, with project work in the sidebar and a pull request ready to merge."
      />

      <p>
        Sessions feature throughout Open Session. You can trigger new sessions
        from schedules or external events, resume the same session over several
        days pursuing a goal, or launch them from tools like Slack, Linear,
        Plain, and GitHub. Sessions can also delegate work to others. Regardless
        of how a session starts, you can open its transcript, watch it work,
        steer it, answer questions, review its changes, and continue the
        conversation.
      </p>

      <h2>Your cloud agents</h2>

      <p>
        Open Session is designed to run in your own cloud (or Mac mini). This
        means you can do fun things like run as many agents as your server can
        handle, close your laptop while an agent is working, and code from your
        phone. But we’ve taken things further and made Open Session fully
        collaborative (for humans).
      </p>

      <p>
        Every session can be shared with your team as a link. Collaborators can
        review, prompt or steer in the same session with you.
      </p>

      <AnnouncementFeatureShot
        feature="collaboration"
        alt="Open Session’s sidebar showing several teammates viewing shared workspaces."
      />

      <p>
        A session lives inside a Workspace, which can support multiple related
        sessions. This is great for longer-running collaboration, where you
        don’t want several people prompting in the same session.
      </p>

      <p>
        Inside a workspace, each session gets its own tab with its own agent,
        model, and transcript. But all sessions in a workspace share the same
        branch and worktree.
      </p>

      <p>
        The general idea is that if you move everything into the cloud then you
        can work faster and with greater flexibility. You can work on more
        things at the same time, and your whole team can participate.
      </p>

      <h2>More ideas</h2>

      <p>
        There's lots more interesting ideas and features in the product. Here's
        a few that our team likes:
      </p>

      <p>
        <strong>Desk mode</strong> is a persistent session for working with an
        agent that can use your entire server as context. You can ask it
        questions like “what’s being worked on right now?” or “is anything stuck
        in Project X?”. You can also use it for starting work more casually by
        first exploring ideas and doing research. The desk mode agent will then
        kick off more powerful sub-agents in new sessions for the work to be
        completed. You can use it like a team standup with your agents.
      </p>

      <AnnouncementFeatureShot
        feature="desk"
        alt="Open Session’s Desk overlay answering a question about active work across the team."
      />

      <p>
        <strong>Automations</strong> are another cool feature. You give your
        agent a repeatable task and it will run periodic sessions required to
        complete the task. At Tella we have automations that review PRs, look
        for sloppy code, maintain product documentation, monitor infosec and a
        bunch more. You can connect automations to another Open Session feature
        called Reports. An automation will generate a periodic report with
        whatever findings you requested. We have reports for Tella’s SEO
        performance, feature requests, identifying patterns in support and
        tracking stale PRs.
      </p>

      <AnnouncementFeatureShot
        feature="automations"
        alt="Open Session’s automations page showing recurring pull request, support, security, and documentation jobs."
      />

      <p>
        We also added a feature called <strong>Walkthroughs</strong>. These are
        written summaries of what the agent completed along with screenshots and
        demo videos. For simple changes, you might decide to ship it based only
        on the walkthrough, but the more important thing is how walkthroughs
        speed up the iteration loop. When you have multiple agents running it’s
        a pain to manually test and verify every iteration - too much context
        and surface switching. In Open Session you can review the agent’s
        screenshots and videos and move on.
      </p>

      <AnnouncementFeatureShot
        feature="walkthroughs"
        alt="A completed Open Session walkthrough with a written summary and a screenshot of the shipped change."
      />

      <h2>Build your own tools</h2>

      <p>
        So far in 2026 we’ve used Cursor, Claude Code, Codex, Conductor, custom
        tmux setups, Amp, agents inside Slack, Devin, OpenClaw and more.
      </p>

      <p>
        Open Session borrows <em>a lot</em> of ideas from these tools. It’s a
        beautiful Frankenstein of them all, but so far, it’s the best one we’ve
        used.
      </p>

      <p>
        The names I mention above are the big dogs, but there’s a big long tail
        of smaller startups in this space. And there are many teams, like ours,
        who’ve built and open sourced their own. So in such a busy space it’s
        valid to ask: why bother doing this at all?
      </p>

      <p>
        The answer is just that it’s an exciting time to be building software.
        So much is changing, and it’s so easy to make something yourself, and
        the best way to figure out where everything is headed is to decide the
        direction yourself.
      </p>

      <p>
        Open Session is our take on how software and startups will be built in
        the future. We hope you like it.
      </p>

      <p>Have fun!</p>

      <a
        className="button button-primary announcement-cta"
        href="https://github.com/tellahq/opensession"
      >
        View on GitHub
      </a>
    </article>
  );
}

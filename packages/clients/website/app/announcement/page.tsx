import type { Metadata } from "next";
import { IconChevronLeft } from "../../../../core/opensession-server/src/frontend/components/icons";
import { AnnouncementArticle } from "../../AnnouncementArticle";
import "./announcement.css";

const title = "Introducing Open Session";
const description =
  "Why we built Open Session, how our team uses it, and why we are open-sourcing our cloud-based agent orchestrator.";

export const metadata: Metadata = {
  title: `${title} · Open Session`,
  description,
  alternates: { canonical: "/announcement" },
  openGraph: {
    type: "article",
    url: "/announcement",
    title,
    description,
    images: ["/opensession-social-landing.png"],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/opensession-social-landing.png"],
  },
};

export default function AnnouncementPage() {
  return (
    <main className="announcement-page" aria-labelledby="announcement-title">
      <nav
        className="announcement-page-nav"
        aria-label="Announcement navigation"
      >
        <a
          className="announcement-page-logo"
          href="/"
          aria-label="Open Session home"
        >
          <img src="/icon.png" alt="" />
        </a>
        <a className="announcement-home" href="/">
          <IconChevronLeft size={17} aria-hidden="true" />
          Back to home
        </a>
      </nav>
      <AnnouncementArticle showDemo />
    </main>
  );
}

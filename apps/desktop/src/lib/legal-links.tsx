import { openUrl } from "@tauri-apps/plugin-opener";

/** The website owns the legal pages. The app only links to them. */
export const TERMS_URL = "https://alkuin.app/terms";
export const PRIVACY_URL = "https://alkuin.app/privacy";
// Copyright reports are a part of the privacy page. /copyright still redirects there.
export const COPYRIGHT_URL = "https://alkuin.app/privacy#copyright";

/** The webview must not navigate itself; the page opens in the browser. */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: string;
}) {
  return (
    <button type="button" className={className} onClick={() => void openUrl(href)}>
      {children}
    </button>
  );
}

/** Under the sign-up button: one sentence, two links. */
export function AgreeLine({ action, linkClassName }: { action: string; linkClassName?: string }) {
  return (
    <>
      By choosing “{action}”, you agree to the{" "}
      <ExternalLink href={TERMS_URL} className={linkClassName}>
        Terms
      </ExternalLink>{" "}
      and confirm you've read how we handle{" "}
      <ExternalLink href={PRIVACY_URL} className={linkClassName}>
        your data
      </ExternalLink>
      .
    </>
  );
}

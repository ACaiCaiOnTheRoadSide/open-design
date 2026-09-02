export function AIDesignWordmark() {
  return (
    <svg
      className="home-hero__title-logo"
      viewBox="20 112 472 195"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby="ohmydesign-wordmark-title ohmydesign-wordmark-desc"
    >
      <title id="ohmydesign-wordmark-title">OhMyDesign</title>
      <desc id="ohmydesign-wordmark-desc">
        OhMyDesign artistic wordmark with an arc and two stars.
      </desc>
      <defs>
        <mask id="ohmydesign-wordmark-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <image href="/ohmydesign-wordmark-mask.svg" width="512" height="512" />
        </mask>
      </defs>
      <rect
        width="512"
        height="512"
        fill="var(--home-logo-paint, var(--home-logo-ink, #3156C8))"
        mask="url(#ohmydesign-wordmark-mask)"
      />
      <path
        className="home-hero__title-star home-hero__title-star--primary"
        d="M444 189C448 207 454 213 472 217C454 221 448 227 444 245C440 227 434 221 416 217C434 213 440 207 444 189Z"
        fill="var(--home-logo-star-primary, #F1BC45)"
      />
      <path
        className="home-hero__title-star home-hero__title-star--secondary"
        d="M98 170C101 183 105 187 118 190C105 193 101 197 98 210C95 197 91 193 78 190C91 187 95 183 98 170Z"
        fill="var(--home-logo-star-secondary, #F3C6D8)"
      />
      <circle cx="377" cy="152" r="5" fill="var(--home-logo-dot, #3156C8)" />
    </svg>
  );
}

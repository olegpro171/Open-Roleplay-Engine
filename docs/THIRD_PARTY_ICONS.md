# Interface icons

Selected paths from [Yandex UI Icons](https://github.com/bem/yandex-ui-icons) are adapted into static React SVG elements in `src/web/Icon.tsx`. The upstream project specifies MPL-2.0, not MIT. The full license and attribution are included in `public/third-party/yandex-ui-icons/`. Vite copies those notices and emits the exact adapted component source alongside them in every client build.

Icons inherit the control color. Decorative SVGs are hidden from assistive technology; icon-only controls retain accessible names and tooltips. The Characters library category uses the Profile icon. Personas uses the user-supplied mask artwork in `src/web/PersonaIcon.tsx`, separate from the Yandex collection. Its original path is preserved, with editor metadata/styles removed and a centered square viewBox; the fill inherits the control color. Chat input/response edit and reasoning icons retain their existing artwork.

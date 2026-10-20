# Interface icons

Selected paths from [Yandex UI Icons](https://github.com/bem/yandex-ui-icons) are adapted into static React SVG elements in `src/web/Icon.tsx`. The upstream project specifies MPL-2.0, not MIT. The full license and attribution are included in `public/third-party/yandex-ui-icons/`. Vite copies those notices and emits the exact adapted component source alongside them in every client build.

Icons inherit the control color. Decorative SVGs are hidden from assistive technology; icon-only controls retain accessible names and tooltips. Persona and Character library categories reserve an empty icon slot for custom artwork. Chat input/response edit and reasoning icons retain their existing artwork.

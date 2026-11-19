import { themeSchema } from '../../src/shared/appearance';
import { checkStoryScroll } from './stream-scroll-scenario';

for (const theme of themeSchema.options) for (const width of [1280, 390]) checkStoryScroll(theme, width);

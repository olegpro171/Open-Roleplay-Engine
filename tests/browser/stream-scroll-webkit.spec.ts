import { checkStoryScroll, test } from './stream-scroll-scenario';

test.use({ browserName: 'webkit' });
checkStoryScroll('dark', 390);

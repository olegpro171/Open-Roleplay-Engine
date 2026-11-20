import { useEffect, useState } from 'react';
import { t, useLocale } from './localization';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export function ChatCardActivity({ timestamp, messageTime, dateFormat }: {
  timestamp: string;
  messageTime: number;
  dateFormat: Intl.DateTimeFormat;
}) {
  useLocale();
  const [now, setNow] = useState(Date.now);
  const elapsed = now - messageTime;
  const exactDate = dateFormat.format(messageTime);
  let displayedDate = exactDate;
  let nextRefresh: number | null = null;

  if (elapsed < 0) {
    nextRefresh = Math.min(-elapsed, day);
  } else if (elapsed < day) {
    const unit = elapsed < hour ? minute : hour;
    const count = Math.floor(elapsed / unit);
    displayedDate = count === 0
      ? t('libraries.chat_activity_less_than_a_minute_ago')
      : t(unit === minute ? 'libraries.chat_activity_minutes_ago' : 'libraries.chat_activity_hours_ago', { count });
    nextRefresh = unit - elapsed % unit;
  } else {
    const today = new Date(now);
    const localMidnight = (offset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset).getTime();
    if (messageTime >= localMidnight(-1)) {
      if (messageTime < localMidnight(0)) displayedDate = t('libraries.chat_activity_yesterday');
      nextRefresh = localMidnight(1) - now;
    }
  }

  useEffect(() => {
    if (nextRefresh === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, now + nextRefresh - Date.now()));
    return () => window.clearTimeout(timer);
  }, [now, nextRefresh]);

  return <time className="chat-card-activity" dateTime={timestamp}
    aria-label={t('libraries.chat_last_message', { date: displayedDate })}
    title={t('libraries.chat_last_message', { date: exactDate })}>{displayedDate}</time>;
}

import { defineMessages } from 'react-intl';
import { COMMON } from './common';
import { FORM } from './form';
import { HELMET } from './helmet';
import { MENU } from './menu';

export const parseIntlText = (intl, text) => {
  if (typeof text === 'object' && text.id) {
    return intl.formatMessage(text);
  }

  return text;
};

const APP_MESSAGES = defineMessages({
  APP_NAME: {
    id: 'app-name',
    description: 'App name',
    defaultMessage: 'White Label Wallet',
  },
  LABEL: {
    id: 'label',
    description: 'Label of the locale',
    defaultMessage: 'English',
  },
  PAGE_NOT_FOUND: {
    id: 'page-not-found',
    description: 'Page not found message',
    defaultMessage: 'The Page you requested was not found!',
  },
});

export const TRANSLATION_KEYS = {
  COMMON,
  FORM,
  HELMET,
  MENU,
  ...APP_MESSAGES,
};

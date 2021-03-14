import { AsyncLocalStorage } from 'async_hooks';
import { Context } from './types';

export const asyncLocalStorage = new AsyncLocalStorage<Context>();

import test from 'ava';
import { ExternalStorage } from '@temporalio/common';
import { loadDataConverter } from '@temporalio/common/lib/internal-non-workflow';
import { makeFakeDriver } from './extstore-fake-driver';

test('loadDataConverter leaves externalStorage undefined when not provided', (t) => {
  t.is(loadDataConverter().externalStorage, undefined);
  t.is(loadDataConverter({}).externalStorage, undefined);
});

test('loadDataConverter passes externalStorage through to the loaded converter', (t) => {
  const externalStorage = new ExternalStorage({ drivers: [makeFakeDriver()] });
  const loaded = loadDataConverter({ externalStorage });
  t.is(loaded.externalStorage, externalStorage);
});

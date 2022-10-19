import { createInstrumenter } from 'istanbul-lib-instrument';
import convertSourceMap from 'convert-source-map';

export default function istanbulLoader(source: any, sourceMap?: string) {
  const instrumenter = createInstrumenter({
    produceSourceMap: true,
    esModules: true,
    compact: false
  });

  // @ts-ignore
  let newSourceMap = sourceMap ? JSON.parse(sourceMap) : undefined;
  if (newSourceMap === undefined) {
    newSourceMap = convertSourceMap.fromSource(source)?.sourcemap;
  }

  console.log('RA', newSourceMap);

  // @ts-ignore
  instrumenter.instrument(source, this.resourcePath, (error, instrumentedSource) => {
    console.log('AG', instrumenter.lastSourceMap());
    // @ts-ignore
    this.callback(error, instrumentedSource, instrumenter.lastSourceMap());
  }, newSourceMap);
}
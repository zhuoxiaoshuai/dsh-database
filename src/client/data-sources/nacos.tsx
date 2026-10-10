import { useNacosBindings, NacosTree } from '../nacos/workspace.tsx'
import React from 'react'
import { nacosSource } from '../../shared/data-sources/nacos.ts'
import { nacosConnectionForm } from '../workspace/connection/connection-form-nacos.tsx'
import { previewJson } from '../workspace/parts/preview-json.tsx'
import type { ClientSourceModule, HistoryDetailSource } from './types.ts'

const nacosInfinity = (
  <>
    <path fill="#2EBBFB" d="M2269.551 857.946a332.108 332.108 0 1 1 317.993-423.715l124.818-134.78a498.162 498.162 0 1 0 4.705 442.81l-130.353-119.835a332.108 332.108 0 0 1-317.163 235.52z" />
    <path fill="#2EBBFB" d="M3334.234 27.676c-275.096 0-456.648 290.594-664.216 498.162C2836.072 691.892 3059.415 1024 3334.234 1024a498.162 498.162 0 1 0 0-996.324z m-29.613 818.37c-177.124 0-320.207-213.38-426.205-320.208 133.397-133.397 249.08-320.208 427.036-320.208a320.208 320.208 0 1 1 0 640.415z" />
  </>
)

const nacosArtwork = (
  <>
    <path className="db-nacos-letter" fill="#2E3034" d="M180.591 1024V361.998L542.035 915.51c10.24 15.222 20.757 29.89 30.997 44.558a251.295 251.295 0 0 0 33.764 37.916 119.559 119.559 0 0 0 39.023 23.524l7.473 1.937h76.661c44.004-13.56 66.422-53.137 66.422-119.558V45.942H619.25v676.116L249.227 161.626l-30.72-47.325a249.081 249.081 0 0 0-27.676-37.086 115.684 115.684 0 0 0-33.21-21.864 108.489 108.489 0 0 0-44.559-8.302A110.703 110.703 0 0 0 51.346 65.59a102.123 102.123 0 0 0-40.684 46.772 207.014 207.014 0 0 0-10.516 73.34V1024z m913.297 0l4.152-11.624L1348.78 292.81l251.295 724.272a57.842 57.842 0 0 1 2.214 6.365h224.45a328.51 328.51 0 0 0-11.347-36.531c-4.705-12.178-9.133-24.355-13.56-37.086L1532.27 249.081c-9.687-27.676-19.096-52.307-27.676-76.385a304.432 304.432 0 0 0-33.21-63.654 149.172 149.172 0 0 0-51.2-45.388 156.09 156.09 0 0 0-76.662-17.436 158.582 158.582 0 0 0-76.662 17.16 143.36 143.36 0 0 0-50.646 45.387 332.108 332.108 0 0 0-33.765 63.931c-9.41 24.078-19.926 48.71-28.506 76.385l-263.749 694.66c-4.428 12.73-9.133 25.184-13.838 37.362a297.79 297.79 0 0 0-12.177 39.3V1024z" />
    {nacosInfinity}
    <path className="db-nacos-letter" fill="#2E3034" d="M4760.362 207.568V0h-544.934a285.89 285.89 0 0 0-285.336 285.613v65.315a285.89 285.89 0 0 0 285.336 285.613h323.528v179.891h-608.864V1024h544.934a285.613 285.613 0 0 0 285.336-285.613v-65.315a285.613 285.613 0 0 0-285.89-285.613h-322.975V207.568z" />
    <path fill="#1BE1F7" d="M4898.74 913.297a110.703 110.703 0 1 0 221.406 0 110.703 110.703 0 1 0-221.406 0z" />
  </>
)

const logo = {
  viewBox: '0 0 5120 1024',
  className: 'db-nacos-logo',
  artwork: nacosArtwork,
  compact: { viewBox: '1750 0 2100 1024', artwork: nacosInfinity },
}

const nacosHistory: HistoryDetailSource = {
  id: 'nacos',
  renderText: record => <section className="db-ai-record-section"><strong>Nacos</strong><p>{record.title || record.operation}</p></section>,
  resultEnvelope: (record, payload) => ({ sourceId: 'nacos', kind: 'nacos', status: record.status, truncated: false, payload }),
  renderResult: envelope => previewJson(envelope.payload),
}

export const nacosModule: ClientSourceModule = {
  id: 'nacos', descriptor: nacosSource, connection: nacosConnectionForm, history: nacosHistory, logo,
  tree: { render: NacosTree },
  workspace: { mode: 'standard', useBindings: useNacosBindings },
}

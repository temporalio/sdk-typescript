import type * as nexus from 'nexus-rpc';
import type { temporal } from '@temporalio/proto';
import { log } from './context';
import { convertNexusLinkToTemporalLink, convertTemporalLinkToNexusLink } from './link-converter';

/**
 * Converts the request links carried on an operation start context into Temporal links so they can
 * be forwarded onto an outgoing RPC (Workflow start/signal/update, Activity start). Links that fail
 * to convert are logged and dropped.
 */
export function requestLinksToTemporalLinks(ctx: nexus.StartOperationContext): temporal.api.common.v1.ILink[] {
  const links = Array<temporal.api.common.v1.ILink>();
  if (ctx.inboundLinks?.length > 0) {
    for (const l of ctx.inboundLinks) {
      try {
        links.push(convertNexusLinkToTemporalLink(l));
      } catch (error) {
        log.warn('failed to convert Nexus link to Workflow event link', { error });
      }
    }
  }
  return links;
}

/**
 * Pushes a response link returned by an outbound RPC onto the operation's outbound links so the
 * Nexus task handler attaches it to the StartOperationResponse, linking the caller's history event
 * back to the callee's.
 */
export function pushResponseLink(ctx: nexus.StartOperationContext, responseLink: temporal.api.common.v1.ILink): void {
  try {
    ctx.outboundLinks.push(convertTemporalLinkToNexusLink(responseLink));
  } catch (error) {
    log.warn('failed to convert temporal link to Nexus link', { error });
  }
}

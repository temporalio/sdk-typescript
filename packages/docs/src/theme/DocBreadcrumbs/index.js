/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Swizzled from facebook/docusaurus@44ebe73e506fb3e09540c7650a6b2db0a1a435a0
// File `packages/docusaurus-theme-classic/src/theme/DocBreadcrumbs/index.tsx`

import React from 'react';
import {
  ThemeClassNames,
  useSidebarBreadcrumbs,
  useHomePageRoute,
} from '@docusaurus/theme-common';
import styles from './styles.module.css';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl'; // TODO move to design system folder

function BreadcrumbsItemLink({children, href}) {
  const className = 'breadcrumbs__link';
  return href ? (
    <Link className={className} href={href} itemProp="item">
      <span itemProp="name">{children}</span>
    </Link>
  ) : (
    <span className={className} itemProp="item name">
      {children}
    </span>
  );
} // TODO move to design system folder

function BreadcrumbsItem({children, active, index}) {
  return (
    <li
      itemScope
      itemProp="itemListElement"
      itemType="https://schema.org/ListItem"
      className={clsx('breadcrumbs__item', {
        'breadcrumbs__item--active': active,
      })}>
      {children}
      <meta itemProp="position" content={String(index + 1)} />
    </li>
  );
}

function HomeBreadcrumbItem() {
  const homeHref = useBaseUrl('/');
  return (
    <li className="breadcrumbs__item">
      <Link
        className={clsx('breadcrumbs__link', styles.breadcrumbsItemLink)}
        href={homeHref}>
        🏠
      </Link>
    </li>
  );
}

export default function DocBreadcrumbs() {
  const breadcrumbs = useSidebarBreadcrumbs();
  const homePageRoute = useHomePageRoute();

  if (!breadcrumbs) {
    return null;
  }

  return (
    <nav
      className={clsx(
        ThemeClassNames.docs.docBreadcrumbs,
        styles.breadcrumbsContainer,
      )}
      aria-label="breadcrumbs">
      <ul
        className="breadcrumbs"
        itemScope
        itemType="https://schema.org/BreadcrumbList">
        {homePageRoute && <HomeBreadcrumbItem />}
        {breadcrumbs.map((item, idx) => (
          <BreadcrumbsItem
            key={idx}
            active={idx === breadcrumbs.length - 1}
            index={idx}>
            <BreadcrumbsItemLink
              href={idx < breadcrumbs.length - 1 ? getHrefFromItem(item) : undefined}>
              {item.label}
            </BreadcrumbsItemLink>
          </BreadcrumbsItem>
        ))}
      </ul>
    </nav>
  );
}

// Only change is adding this function and using it on L89
function getHrefFromItem(item) {
  return item.customProps?.breadcrumbLink || item.href;
}
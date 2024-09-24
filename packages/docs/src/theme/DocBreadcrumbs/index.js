import React from 'react';
import { useSidebarBreadcrumbs } from '@docusaurus/plugin-content-docs/client';
import { useHomePageRoute } from '@docusaurus/theme-common/internal';
import Link from '@docusaurus/Link';

export default function DocBreadcrumbs() {
  const breadcrumbs = useSidebarBreadcrumbs();
  const homePageRoute = useHomePageRoute();

  if (!breadcrumbs) {
    return null;
  }

  return (
    <nav aria-label="breadcrumbs">
      <ul className="breadcrumbs">
        <li className="breadcrumbs__item">
          <Link className="breadcrumbs__link" href={homePageRoute.path}>
            🏠
          </Link>
        </li>
        {breadcrumbs.map((item, idx) => (
          <li key={idx} className={getItemClassNames(breadcrumbs, idx)}>
            <Link className="breadcrumbs__link" href={getHrefFromItem(item)}>
              <span>{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function getItemClassNames(breadcrumbs, idx) {
  const classes = ['breadcrumbs__item'];
  if (idx === breadcrumbs.length - 1) {
    classes.push('breadcrumbs__item--active');
  }
  return classes.join(' ');
}

function getHrefFromItem(item) {
  return item.customProps?.breadcrumbLink || item.href;
}

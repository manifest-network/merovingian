# Working on Merovingian

Prepare repository changes and tests within the requested scope. Every production
change requires the user's explicit authorization for the concrete action,
including deployments, updates, DNS changes, monitoring installation, and rollback.
A product preference or approval of a plan is not production deployment approval.

Keep Merovingian application work in this repository. Do not put application-specific
monitoring or operations in `manifest-deploy` or modify Fred environments.

Keep credentials, wallet material, operation journals, and personal filesystem
paths out of source, Git history, container images, and public reports. Do not
perform paid operations or live visits as incidental validation: live visits
increment the public serving totals and need an authorized test scope.

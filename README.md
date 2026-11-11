# KURO landing page

Static, buildless HTML/CSS/JavaScript for <https://benmidi.github.io/kuro-site/>.
The app's source remains in the private `Benmidi/kuro` repo; `Benmidi/kuro-site`
contains **only the contents of this directory**. GitHub Pages is unavailable for
the private app repo on the current GitHub plan.

## Preview

From the app checkout: `python3 -m http.server 4173 --directory website`, then
open <http://localhost:4173>. No build tools, package installation, analytics,
third-party JavaScript, or runtime font requests are needed.

The page is a single matte surface with a giant recessed KURO wordmark. A
WebGL shader renders machined cut edges, frosted acrylic, RGB LCD subpixels,
softbox reflections and independently drifting light behind each letter. It
uses the app tab bar's material vocabulary; it is a browser approximation of
those materials rather than a direct port of the Metal pipeline.

Move the pointer to shift the lighting and parallax. Hold the wordmark (or
hold Space/Enter while focused) to bring the LCDs closer to the acrylic. The
scene follows reduced-motion preferences, pausing its ambient motion when
requested. Rendering stops while the page is hidden, caps at 30
fps and 1800 pixels on the longest edge, and uses at most 1.5x device resolution.
A static CSS wordmark remains available without WebGL. No camera permission,
video, photo asset, analytics, or third-party runtime dependencies are used.

`app.js` owns only the material renderer; `waitlist.js` owns signup and privacy
interactions so changes to the visual do not affect the backend contract.

## Waitlist

`waitlist.js` calls the `kuro-waitlist` Supabase Edge Function in KuroApp. No API key
is included in the public site. The function uses its environment's service-role
key to call a service-only SQL function. The migration enables RLS and revokes
all visitor access to the email and limiter tables. Existing addresses are not
disclosed, duplicated, or modified on a second signup. No emails are sent by
this endpoint; sending launch invitations is a separate future task.

The form records email, device preference and signup time. The privacy dialog
allows email removal. Removal deliberately requires only knowing the exact
email and is rate limited; this is suitable for a low-stakes waitlist, not an
account or authenticated subscription system. All responses are non-enumerating.

Abuse mitigation: bounded request size, validation, allowed origins, honeypot,
and an atomic database limit of eight requests per network bucket per hour.
CORS is not authentication. Forwarded network identity is best effort on the
hosted gateway; add a verified CAPTCHA/WAF if this becomes an abuse target.
Raw IPs are not saved in the database. Salted hashes expire on subsequent
requests after 24 hours. For the underlying platform's rate-limit guidance see
<https://supabase.com/docs/guides/functions/examples/rate-limiting>.

Inspect/export the list as the project owner in Supabase Dashboard → Table
Editor → `kuro_waitlist`. Email data must never go into GitHub.

After the source PR is merged, deploy only these changes (no auth config push):

```sh
supabase db push --remote=rqirmprdejkkfvzhttco
supabase functions deploy kuro-waitlist --remote=rqirmprdejkkfvzhttco --use-api
```

## Publish updates

Run `scripts/publish-website.sh` from the app checkout. It uses the existing `gh`
and Git login, clones the public marketing repo into ignored local work, copies
only `website/`, commits and pushes it. GitHub Pages deploys the root of `main`.
It never copies app code, `.git` metadata, Supabase source, environment files,
or credentials. Review the public diff before calling the script when adding
new site files. Download URLs should replace the early-access CTA only after
real App Store/Play Store/TestFlight links exist.

## Assets

The wordmark's signed-distance texture is generated at runtime from the
self-hosted Barlow Condensed font using an exact Euclidean distance transform.
LCD light and all material effects are procedural. No generated photography is
used in this version. `assets/social-preview.png` is a screenshot of the page.

Barlow Condensed and DM Sans are self-hosted under the SIL Open Font License;
their license files ship in `assets/`. The favicon is SVG.

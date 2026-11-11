# KURO landing page

Static, buildless HTML/CSS/JavaScript for <https://benmidi.github.io/kuro-site/>.
The app's source remains in the private `Benmidi/kuro` repo; `Benmidi/kuro-site`
contains **only the contents of this directory**. GitHub Pages is unavailable for
the private app repo on the current GitHub plan.

## Preview

From the app checkout: `python3 -m http.server 4173 --directory website`, then
open <http://localhost:4173>. No build tools, package installation, analytics,
third-party JavaScript, or runtime font requests are needed.

The hero is an illustrative WebGL 1 stock study, with film curves, live grain,
halation, vignette, subtle five-frame registration and expired-film light leak.
It approximates the native stocks; it is not a port of the Metal pipeline or an
app screenshot. The source photo is static. Select SUMI, MIST or KARE; adjust
exposure; pause motion; press the shutter for a demo capture. The demo saves
nothing. Offscreen/hidden rendering is suspended, GPU resolution is capped,
reduced-motion preferences start the demo paused, and a still image remains
visible when WebGL is unavailable. The orange ticker also pauses with the demo.

## Waitlist

`app.js` calls the `kuro-waitlist` Supabase Edge Function in KuroApp. No API key
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

`assets/after-rain.jpg` was generated with the built-in imagegen tool. Prompt:

> Use case: photorealistic-natural. Asset type: photograph for an indie analog loop camera app landing page, later treated with live WebGL film grain. Create a cinematic candid 35mm street photograph of a lone cyclist riding through a narrow Tokyo backstreet after rain at blue hour, side-on three-quarter composition, cyclist in right middle of image, beautiful glowing red-orange lanterns and one small warmly lit shop on the left, dark concrete and overhead wires, wet ground catching neon reflections, a slightly blurred sense of movement, rich teal shadows and warm amber lights. An authentic quiet accidental moment, artful film photography, natural fine grain, restrained colors, deep dark shadows with readable detail. Landscape 3:2 photo, no borders, no graphic layout, no captions, no recognizable brands, no readable text. Should feel human and imperfect rather than glossy futuristic cyberpunk. Small cyclist full body visible with plenty of streetscape.

Barlow Condensed and DM Sans are self-hosted under the SIL Open Font License;
their license files ship in `assets/`. Favicon and cartridge artwork are SVG/CSS.

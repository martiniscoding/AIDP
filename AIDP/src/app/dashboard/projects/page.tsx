import { redirect } from "next/navigation";

/**
 * There is one list of projects, and it is the workspace home.
 *
 * This route used to hold a second copy of it. Kept as a redirect rather than
 * deleted because `/dashboard/projects/:id` is where every project link points,
 * so people trim the id off the URL, and because the address is in bookmarks
 * and in the browser history of anyone who used it.
 */
export default function ProjectsIndex() {
  redirect("/dashboard");
}

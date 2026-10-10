import { render } from "preact";
import { LocationProvider, Route, Router } from "preact-iso";
import { Admin } from "./pages/Admin";
import { AdminSettings } from "./pages/AdminSettings";
import { Home } from "./pages/Home";
import { NotFound } from "./pages/NotFound";
import { Profile } from "./pages/Profile";
import "./styles.css";

function App() {
  return (
    <LocationProvider>
      <Router>
        <Route path="/" component={Home} />
        <Route path="/login" component={Home} />
        <Route path="/profile" component={Profile} />
        <Route path="/admin" component={Admin} />
        <Route path="/admin/settings" component={AdminSettings} />
        <Route default component={NotFound} />
      </Router>
    </LocationProvider>
  );
}

render(<App />, document.getElementById("app")!);

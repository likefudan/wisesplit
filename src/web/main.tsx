import { render } from "preact";
import { LocationProvider, Route, Router } from "preact-iso";
import { Admin } from "./pages/Admin";
import { AdminSettings } from "./pages/AdminSettings";
import { NewExpense } from "./pages/Expenses";
import { GroupPage, NewGroup } from "./pages/Groups";
import { Home } from "./pages/Home";
import { Invite } from "./pages/Invite";
import { NewPayment } from "./pages/Payments";
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
        <Route path="/groups/new" component={NewGroup} />
        <Route path="/groups/:id" component={GroupPage} />
        <Route path="/groups/:id/expenses/new" component={NewExpense} />
        <Route path="/groups/:id/pay" component={NewPayment} />
        <Route path="/invite/:token" component={Invite} />
        <Route path="/admin" component={Admin} />
        <Route path="/admin/settings" component={AdminSettings} />
        <Route default component={NotFound} />
      </Router>
    </LocationProvider>
  );
}

render(<App />, document.getElementById("app")!);

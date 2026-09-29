import React, { useState, useEffect } from 'react';
import { erpDb } from './services/db';
import { AuthService, AuthSession } from './services/auth';
import { RoleName, User } from './types/erp';
import { PermissionService } from './services/permissions';
import { Sidebar, NavTab } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { LoginView } from './components/auth/LoginView';

// Module Views
import { DashboardView } from './components/modules/DashboardView';
import { ProductsMasterView } from './components/modules/ProductsMasterView';
import { SalesView } from './components/modules/SalesView';
import { PurchasingView } from './components/modules/PurchasingView';
import { InventoryView } from './components/modules/InventoryView';
import { ManufacturingView } from './components/modules/ManufacturingView';
import { QualityView } from './components/modules/QualityView';
import { CostingView } from './components/modules/CostingView';
import { CustomersView } from './components/modules/CustomersView';
import { SuppliersView } from './components/modules/SuppliersView';
import { RepresentativesView } from './components/modules/RepresentativesView';
import { ExportView } from './components/modules/ExportView';
import { TreasuryView } from './components/modules/TreasuryView';
import { BanksView } from './components/modules/BanksView';
import { ChequesView } from './components/modules/ChequesView';
import { ExpensesView } from './components/modules/ExpensesView';
import { AccountingView } from './components/modules/AccountingView';
import { ReportsView } from './components/modules/ReportsView';
import { UsersView } from './components/modules/UsersView';
import { SettingsView } from './components/modules/SettingsView';
import { AuditLogView } from './components/modules/AuditLogView';
import { TestRunnerModal } from './components/modules/TestRunnerModal';

export function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const session = AuthService.getCurrentSession();
    return session ? session.user : null;
  });

  // Persist the last opened module so refreshes keep context (still permission-gated)
  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    const saved = localStorage.getItem('snakdip_erp_active_tab') as NavTab | null;
    return saved || 'dashboard';
  });

  useEffect(() => {
    localStorage.setItem('snakdip_erp_active_tab', activeTab);
  }, [activeTab]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isTestRunnerOpen, setIsTestRunnerOpen] = useState(false);
  const [currentRole, setCurrentRole] = useState<RoleName>(() => {
    const session = AuthService.getCurrentSession();
    return session ? session.user.role : 'Super Admin';
  });
  const [, setDbVersion] = useState(0);

  // Re-render when database mutates
  useEffect(() => {
    const unsubscribe = erpDb.subscribe(() => {
      setDbVersion(v => v + 1);
    });
    return unsubscribe;
  }, []);

  const handleLoginSuccess = (user: User) => {
    setCurrentUser(user);
    setCurrentRole(user.role);
  };

  const handleLogout = () => {
    AuthService.logout();
    setCurrentUser(null);
  };

  const handleRoleChange = (role: RoleName) => {
    // Service-level restriction: only a Super Admin session may switch roles
    const res = AuthService.updateSessionRole(role);
    if (!res.success) {
      alert(res.error || 'غير مصرح بتبديل الدور');
      return;
    }
    setCurrentRole(role);
    // If the new role cannot view the currently open tab, bounce to the dashboard
    if (!PermissionService.canView(role, activeTab)) {
      setActiveTab('dashboard');
    }
  };

  // Guard persisted tab against roles that cannot view it (e.g. after logout/login as another role)
  useEffect(() => {
    if (currentUser && !PermissionService.canView(currentUser.role, activeTab)) {
      setActiveTab('dashboard');
    }
  }, [currentUser, activeTab]);

  // If not logged in, show Login Screen
  if (!currentUser) {
    return <LoginView onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen bg-cream-100 text-ink-900 font-sans flex flex-col antialiased" dir="rtl">
      {/* Sidebar */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        currentUser={currentUser}
        onLogout={handleLogout}
      />

      {/* Main Content Area (offset by sidebar width on lg) */}
      <div className="flex-1 lg:mr-72 flex flex-col min-w-0">
        <Header
          onToggleSidebar={() => setIsSidebarOpen(o => !o)}
          currentUser={currentUser}
          currentUserRole={currentRole}
          onRoleChange={handleRoleChange}
          onLogout={handleLogout}
          onUserUpdated={(u) => setCurrentUser(u)}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto animate-fade-in">
          {activeTab === 'dashboard' && (
            <DashboardView
              onNavigateTab={(tab) => setActiveTab(tab as NavTab)}
              openTestRunner={() => setIsTestRunnerOpen(true)}
            />
          )}
          {activeTab === 'items' && <ProductsMasterView />}
          {activeTab === 'sales' && <SalesView />}
          {activeTab === 'purchasing' && <PurchasingView />}
          {activeTab === 'inventory' && <InventoryView />}
          {activeTab === 'manufacturing' && <ManufacturingView />}
          {activeTab === 'quality' && <QualityView />}
          {activeTab === 'costing' && <CostingView />}
          {activeTab === 'customers' && <CustomersView />}
          {activeTab === 'suppliers' && <SuppliersView />}
          {activeTab === 'representatives' && <RepresentativesView />}
          {activeTab === 'export' && <ExportView />}
          {activeTab === 'treasury' && <TreasuryView />}
          {activeTab === 'banks' && <BanksView />}
          {activeTab === 'cheques' && <ChequesView />}
          {activeTab === 'expenses' && <ExpensesView />}
          {activeTab === 'accounting' && <AccountingView />}
          {activeTab === 'reports' && <ReportsView />}
          {activeTab === 'users' && <UsersView />}
          {activeTab === 'settings' && (
            <SettingsView openTestRunner={() => setIsTestRunnerOpen(true)} />
          )}
          {activeTab === 'audit' && <AuditLogView />}
        </main>
      </div>

      {/* Test Runner Modal */}
      <TestRunnerModal
        isOpen={isTestRunnerOpen}
        onClose={() => setIsTestRunnerOpen(false)}
      />
    </div>
  );
}

export default App;

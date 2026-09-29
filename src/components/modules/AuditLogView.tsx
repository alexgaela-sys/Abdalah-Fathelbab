import React, { useState } from 'react';
import { 
  History, Search, Shield, Filter, 
  Clock, ArrowDownRight, User
} from 'lucide-react';
import { erpDb } from '../../services/db';

export const AuditLogView: React.FC = () => {
  const db = erpDb.getSnapshot();
  const [searchQuery, setSearchQuery] = useState('');
  const [actionFilter, setActionFilter] = useState('all');

  const filteredLogs = db.auditLogs.filter(log => {
    const text = `${log.description} ${log.userName} ${log.module} ${log.recordId}`.toLowerCase();
    const matchesSearch = text.includes(searchQuery.toLowerCase());
    const matchesAction = actionFilter === 'all' || log.action === actionFilter;
    return matchesSearch && matchesAction;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-slate-900">سجل تدقيق العمليات (Audit Log)</h2>
          <p className="text-xs text-slate-500 mt-1">
            توثيق كامل لكل عملية إنشاء أو ترحيل أو تعديل أو اعتماد أو إلغاء عكسي بالوقت واسم المستخدم
          </p>
        </div>
      </div>

      {/* Search & Filter */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3" />
          <input
            type="text"
            placeholder="بحث بالوصف أو اسم المستخدم أو الوحدة..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pr-9 pl-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs focus:outline-none focus:border-amber-500 text-right"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-slate-700">نوع الحركة:</span>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="p-1.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-semibold"
          >
            <option value="all">كافة الحركات</option>
            <option value="post">ترحيل (Post)</option>
            <option value="create">إنشاء (Create)</option>
            <option value="edit">تعديل (Edit)</option>
            <option value="reverse">قيد عكسي (Reverse)</option>
          </select>
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <table className="w-full text-right text-xs">
          <thead className="bg-slate-100 text-slate-700 font-bold">
            <tr>
              <th className="p-3.5">الوقت والتاريخ</th>
              <th className="p-3.5">المستخدم</th>
              <th className="p-3.5">الوحدة / القسم</th>
              <th className="p-3.5 text-center">نوع الإجراء</th>
              <th className="p-3.5">رقم المعاملة</th>
              <th className="p-3.5">تفاصيل وبيان الحركة</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredLogs.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-slate-400">
                  لا توجد سجلات تدقيق مسجلة حتى الآن
                </td>
              </tr>
            ) : (
              filteredLogs.slice().reverse().map(log => (
                <tr key={log.id} className="hover:bg-slate-50">
                  <td className="p-3.5 font-mono text-slate-600">
                    {new Date(log.timestamp).toLocaleString('ar-EG')}
                  </td>
                  <td className="p-3.5 font-bold text-slate-800 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-slate-400" />
                    <span>{log.userName}</span>
                  </td>
                  <td className="p-3.5 font-semibold text-indigo-700">{log.module}</td>
                  <td className="p-3.5 text-center">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                      log.action === 'post' ? 'bg-emerald-100 text-emerald-800' :
                      log.action === 'reverse' ? 'bg-rose-100 text-rose-800' :
                      log.action === 'create' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'
                    }`}>
                      {log.action === 'post' ? 'ترحيل دفتري' :
                       log.action === 'reverse' ? 'إلغاء وعكس' :
                       log.action === 'create' ? 'إنشاء جديد' : log.action}
                    </span>
                  </td>
                  <td className="p-3.5 font-mono text-slate-600">{log.recordId}</td>
                  <td className="p-3.5 text-slate-800">{log.description}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
